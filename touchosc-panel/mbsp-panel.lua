--[[
MBSP Snapshot Panel: root script for a TouchOSC demo panel.

Save snapshots the panel's generic controls and stores them on an MBSP server.
Load lists the snapshots on the selected server, and tapping one restores it.
Discover finds every MBSP server on the MIDI connection (up to four are shown).

Everything here is plain Lua 5.1 (TouchOSC's dialect): no bitwise operators and no
integer division, so CRC-32 and the 7-bit packing are done with arithmetic.

The buttons' own scripts call root:notify(<action>, <index>), handled by onReceiveNotify.
]]

------------------------------------------------------------------------------
-- Settings
------------------------------------------------------------------------------
local SUB_ID         = 0x6A        -- MBSP Universal Non-Real Time Sub-ID #1 (draft placeholder)
local VERSION        = 1
local BROADCAST      = 0x0FFFFFFF
local IDENTITY       = { 0x7D, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00 } -- 7Dh = non-commercial / educational ID
local DEVICE_NAME    = "TouchOSC Panel"
local PAYLOAD_TYPE   = 0x01        -- Patch / Program: a single preset of the panel
local BLOCK_SIZE     = 256         -- Store / Retrieve block size
local ACK_TIMEOUT    = 1000        -- ms before resending a Store message
local MAX_RETRIES    = 3
local DISCOVER_WAIT  = 1000        -- ms to collect OnlineServer replies
local REPLY_WAIT     = 3000        -- ms to wait for a reply before giving up
local ROWS           = 6           -- snapshot rows shown per page
local MAX_SERVERS    = 4
local DEBUG          = false       -- true: log received MBSP messages to TouchOSC's script console

local MSG = {
  DISCOVER = 0, ONLINE = 1, STATUS = 2,
  STORE_HEADER = 10, STORE_BLOCK = 11, STORE_ACK = 12,
  RETRIEVE_REQUEST = 20, RETRIEVE_HEADER = 21, RETRIEVE_BLOCK = 22, RETRIEVE_ACK = 23,
  QUERY_REQUEST = 30, QUERY_RESULT = 31,
}
local STATUS_NAME = {
  [0] = "OK", [1] = "Not Found", [2] = "Refused", [3] = "Checksum Error", [4] = "Block Sequence Error",
  [5] = "Timeout", [6] = "Storage Full", [7] = "Busy", [8] = "Invalid Request", [9] = "Unknown Transaction",
}

-- The controls a snapshot captures: { control name, value key, kind }.
-- "float" values are 0..1, "int" values are small whole numbers (radio index).
local SNAPSHOT = {
  { "fader1", "x", "float" }, { "fader2", "x", "float" }, { "fader3", "x", "float" }, { "fader4", "x", "float" },
  { "knob1", "x", "float" },  { "knob2", "x", "float" },  { "knob3", "x", "float" },  { "knob4", "x", "float" },
  { "xy", "x", "float" },     { "xy", "y", "float" },
  { "toggle1", "x", "float" }, { "toggle2", "x", "float" }, { "toggle3", "x", "float" }, { "toggle4", "x", "float" },
  { "mode", "x", "int" },
}
local SNAPSHOT_FORMAT = 1

------------------------------------------------------------------------------
-- State
------------------------------------------------------------------------------
local myMuid = 0
local tidCounter = 0
local servers = {}        -- { { muid, name } } in discovery order
local selected = nil      -- index into servers
local op = nil            -- the operation in progress (one at a time)
local page = { start = 0, total = 0, results = {} }
local recentSent = {}     -- recently sent messages, to recognise echoes (MUID collision check)

------------------------------------------------------------------------------
-- Small helpers
------------------------------------------------------------------------------
local floor = math.floor

local function now() return getMillis() end

local function find(name) return root:findByName(name, true) end

local function setText(name, text)
  local c = find(name)
  if c then c.values.text = text end
end

local function status(text) setText("status", text) end

local function log(...)
  if DEBUG then print("[MBSP]", ...) end
end

-- A plain array of whole numbers, framed F0 ... F7, whatever shape the host passed in.
local function normalize(message)
  local m = {}
  for i = 1, #message do m[i] = floor(tonumber(message[i]) or 0) end
  if m[1] ~= 0xF0 then table.insert(m, 1, 0xF0) end
  if m[#m] ~= 0xF7 then m[#m + 1] = 0xF7 end
  return m
end

local function bytesKey(m)
  local t = {}
  for i = 1, #m do t[i] = string.format("%d", m[i]) end
  return table.concat(t, ",")
end

local function hex(v, digits)
  return string.format("%0" .. digits .. "X", floor(v))
end

local function randomMuid()
  -- 28 random bits from two draws, avoiding the reserved range 0FFFFF00-0FFFFFFF
  local m
  repeat
    m = math.random(0, 16383) * 16384 + math.random(0, 16383)
  until m < 0x0FFFFF00
  return m
end

local function nextTid()
  tidCounter = (tidCounter + 1) % 16384
  return tidCounter
end

-- 32-bit constants are written as floats: Lua 5.1 (TouchOSC) uses doubles anyway, and this keeps
-- the code right in Lua VMs whose integers are only 32 bits wide.
local POLY, ALL_ONES = 3988292384.0, 4294967295.0 -- EDB88320h, FFFFFFFFh

-- XOR of two 32-bit numbers, by arithmetic (Lua 5.1 has no bitwise operators).
local function bxor(a, b)
  local r, bit = 0.0, 1.0
  for _ = 1, 32 do
    local x, y = a % 2, b % 2
    if x ~= y then r = r + bit end
    a = (a - x) / 2
    b = (b - y) / 2
    bit = bit * 2
  end
  return r
end

local CRC_TABLE = {}
for n = 0, 255 do
  local c = n
  for _ = 1, 8 do
    if c % 2 == 1 then c = bxor(POLY, floor(c / 2)) else c = floor(c / 2) end
  end
  CRC_TABLE[n] = c
end

-- CRC-32 (IEEE 802.3 / zlib), the MBSP Full Payload Checksum.
local function crc32(bytes)
  local c = ALL_ONES
  for i = 1, #bytes do
    c = bxor(CRC_TABLE[bxor(c % 256, bytes[i])], floor(c / 256))
  end
  return bxor(c, ALL_ONES)
end

------------------------------------------------------------------------------
-- Writing and reading 7-bit fields
------------------------------------------------------------------------------
local function put(t, v) t[#t + 1] = v end
local function putN(t, v, n) -- n 7-bit groups, least significant first
  for _ = 1, n do put(t, floor(v % 128)); v = floor(v / 128) end
end
local function putStr(t, s)
  put(t, #s)
  for i = 1, #s do put(t, string.byte(s, i)) end
end

-- A Reader walks a message's payload. TouchOSC's sandbox has no setmetatable, so each reader
-- gets its methods copied in instead of inheriting them through a metatable.
local Reader = {}
local function reader(bytes, from, to)
  return { b = bytes, p = from, e = to,
    left = Reader.left, n = Reader.n, bytes = Reader.bytes, str = Reader.str, record = Reader.record }
end
function Reader:left() return self.e - self.p + 1 end
function Reader:n(count)
  if self:left() < count then error("message too short") end
  local v, mul = 0, 1.0
  for i = 0, count - 1 do v = v + self.b[self.p + i] * mul; mul = mul * 128 end
  self.p = self.p + count
  return floor(v) -- a whole number, so it prints as "12", not "12.0", in Lua 5.3+
end
function Reader:bytes(count)
  if self:left() < count then error("message too short") end
  local out = {}
  for i = 0, count - 1 do out[#out + 1] = self.b[self.p + i] end
  self.p = self.p + count
  return out
end
function Reader:str()
  local len = self:n(1)
  local chars = self:bytes(len)
  local s = {}
  for i = 1, #chars do s[i] = string.char(chars[i]) end
  return table.concat(s)
end
function Reader:record()   -- the metadata shared by Retrieve_Header and Query_Result
  local r = {}
  r.identity = self:bytes(7)
  r.deviceName = self:str()
  r.sysexId = self:n(1)
  r.type = self:n(1)
  r.number = self:str()
  r.name = self:str()
  r.tags = {}
  for i = 1, self:n(1) do r.tags[i] = self:str() end
  return r
end

------------------------------------------------------------------------------
-- MBSP envelope
------------------------------------------------------------------------------
local function send(msgType, dst, tid, payload)
  local m = { 0xF0, 0x7E, 0x7F, SUB_ID, 0x00, VERSION, 0 } -- no Access Key
  putN(m, myMuid, 4)
  putN(m, dst, 4)
  putN(m, tid, 2)
  put(m, msgType)
  for i = 1, #payload do put(m, payload[i]) end
  local sum = 0
  for i = 2, #m do sum = sum + m[i] end
  put(m, (128 - sum % 128) % 128)
  put(m, 0xF7)
  table.insert(recentSent, { key = bytesKey(m), at = now() })
  if #recentSent > 32 then table.remove(recentSent, 1) end
  sendMIDI(m)
  return m
end

-- Returns { src, dst, tid, type, r = Reader over the payload } or nil if this is not a valid MBSP message.
local function decode(m)
  local n = #m
  if n < 20 or m[1] ~= 0xF0 or m[n] ~= 0xF7 then return nil end
  if m[2] ~= 0x7E or m[3] ~= 0x7F or m[4] ~= SUB_ID or m[5] ~= 0x00 or m[6] ~= VERSION then return nil end
  local sum = 0
  for i = 2, n - 2 do
    if m[i] > 0x7F then return nil end
    sum = sum + m[i]
  end
  if (128 - sum % 128) % 128 ~= m[n - 1] then return nil end
  local keyLen = m[7]
  if keyLen > 16 or 8 + keyLen + 11 > n - 1 then return nil end
  local r = reader(m, 8 + keyLen, n - 2)
  local d = { src = r:n(4), dst = r:n(4), tid = r:n(2), type = r:n(1) }
  d.r = r
  return d
end

------------------------------------------------------------------------------
-- Snapshot encoding: format, count, then one 14-bit value per entry
------------------------------------------------------------------------------
local function takeSnapshot()
  local p = { SNAPSHOT_FORMAT, #SNAPSHOT }
  for _, e in ipairs(SNAPSHOT) do
    local c = find(e[1])
    local v = c and c.values[e[2]] or 0
    if v == true then v = 1 elseif v == false then v = 0 end
    local q
    if e[3] == "int" then q = floor(v + 0.5) else q = floor(math.max(0, math.min(1, v)) * 16383 + 0.5) end
    putN(p, math.max(0, math.min(16383, q)), 2)
  end
  return p
end

local function applySnapshot(p)
  if p[1] ~= SNAPSHOT_FORMAT then return false, "unknown snapshot format" end
  local count = math.min(p[2] or 0, #SNAPSHOT)
  if #p < 2 + count * 2 then return false, "snapshot too short" end
  for i = 1, count do
    local e = SNAPSHOT[i]
    local q = p[1 + i * 2] + p[2 + i * 2] * 128
    local c = find(e[1])
    if c then
      if e[3] == "int" then c.values[e[2]] = q else c.values[e[2]] = q / 16383 end
    end
  end
  return true
end

------------------------------------------------------------------------------
-- Display
------------------------------------------------------------------------------
local ON, OFF = Color(0.10, 0.75, 0.55, 1), Color(0.22, 0.26, 0.30, 1)

local function showServers()
  for i = 1, MAX_SERVERS do
    local s = servers[i]
    local btn = find("server" .. i)
    if s then
      setText("server" .. i .. "Label", s.name .. "  " .. hex(s.muid, 7))
      if btn then btn.properties.color = (i == selected) and ON or OFF end
    else
      setText("server" .. i .. "Label", "")
      if btn then btn.properties.color = OFF end
    end
  end
end

local function showPage()
  for i = 1, ROWS do
    local r = page.results[page.start + i - 1]
    if r then
      setText("row" .. i .. "Label", string.format("#%d  %s  (%s)", r.recordId, r.name ~= "" and r.name or "(no name)", r.number))
    else
      setText("row" .. i .. "Label", "")
    end
  end
  if page.total > 0 then
    setText("pageLabel", string.format("%d-%d of %d", page.start + 1, math.min(page.start + ROWS, page.total), page.total))
  else
    setText("pageLabel", "")
  end
end

local function server()
  return selected and servers[selected] or nil
end

------------------------------------------------------------------------------
-- Operations
------------------------------------------------------------------------------
local function finish(text)
  op = nil
  if text then status(text) end
end

local function discover()
  servers, selected = {}, nil
  showServers()
  op = { kind = "discover", tid = nextTid(), deadline = now() + DISCOVER_WAIT }
  send(MSG.DISCOVER, BROADCAST, op.tid, {})
  status("Looking for MBSP servers...")
end

local function queryPayload(start, maxResults)
  local p = {}
  put(p, 3)                                   -- Device Match Mode 3: this exact model
  for i = 1, 7 do put(p, IDENTITY[i]) end
  put(p, 0x7F)                                -- any SysEx ID
  put(p, PAYLOAD_TYPE)
  putStr(p, ""); putStr(p, "")                -- any number, any name
  put(p, 0)                                   -- no tag filters
  putN(p, start, 2)
  put(p, maxResults)
  return p
end

local function sendQuery(start)
  local s = server()
  op = { kind = "query", tid = nextTid(), deadline = now() + REPLY_WAIT, start = start, got = 0 }
  page.start = start
  page.results = {}
  send(MSG.QUERY_REQUEST, s.muid, op.tid, queryPayload(start, ROWS))
  status("Reading snapshots from " .. s.name .. "...")
end

-- Save, step 1: count the panel's snapshots, to number the new one.
local function save()
  local s = server()
  if not s then return status("Discover and choose a server first") end
  op = { kind = "count", tid = nextTid(), deadline = now() + REPLY_WAIT }
  send(MSG.QUERY_REQUEST, s.muid, op.tid, queryPayload(0, 1))
  status("Saving to " .. s.name .. "...")
end

-- Save, step 2: the Store itself, sent block by block as the server acks.
local function store(existing)
  local s = server()
  local data = takeSnapshot()
  local n = existing + 1
  local numBlocks = math.max(1, math.ceil(#data / BLOCK_SIZE))
  local h = {}
  putN(h, 0, 3)                               -- Replace Record ID 0: a new Record
  for i = 1, 7 do put(h, IDENTITY[i]) end
  putStr(h, DEVICE_NAME)
  put(h, 0x7F)                                -- no SysEx ID
  put(h, PAYLOAD_TYPE)
  putStr(h, string.format("%03d", n % 1000))  -- Payload Number
  putStr(h, "Snapshot " .. n)                 -- Payload Name
  put(h, 1); putStr(h, "TouchOSC")            -- one tag
  putN(h, #data, 3)                           -- Payload Size
  putN(h, numBlocks, 2)
  putN(h, crc32(data), 5)
  op = { kind = "store", tid = nextTid(), data = data, numBlocks = numBlocks, name = "Snapshot " .. n }
  op.last = { MSG.STORE_HEADER, h }
  op.want = 0
  op.retries = 0
  op.deadline = now() + ACK_TIMEOUT
  send(MSG.STORE_HEADER, s.muid, op.tid, h)
end

local function sendStoreBlock(i)
  local b = {}
  putN(b, i, 2)
  local from = i * BLOCK_SIZE + 1
  local to = math.min(#op.data, from + BLOCK_SIZE - 1)
  putN(b, to - from + 1, 2)
  for k = from, to do put(b, op.data[k]) end
  op.last = { MSG.STORE_BLOCK, b }
  op.want = (i + 1 < op.numBlocks) and (i + 1) or nil -- nil: the last block is answered by the Status
  op.retries = 0
  op.deadline = now() + ACK_TIMEOUT
  send(MSG.STORE_BLOCK, server().muid, op.tid, b)
end

local function retrieve(recordId)
  local s = server()
  local p = {}
  putN(p, recordId, 3)
  putN(p, BLOCK_SIZE, 2)                      -- Max Block Size
  op = { kind = "retrieve", tid = nextTid(), deadline = now() + REPLY_WAIT, recordId = recordId, next = 0, data = {} }
  send(MSG.RETRIEVE_REQUEST, s.muid, op.tid, p)
  status("Loading #" .. recordId .. "...")
end

local function retrieveAck(n)
  local p = {}
  putN(p, n, 2)
  send(MSG.RETRIEVE_ACK, server().muid, op.tid, p)
end

------------------------------------------------------------------------------
-- Receiving
------------------------------------------------------------------------------
local function isEcho(m)
  local key, t = bytesKey(m), now()
  for _, e in ipairs(recentSent) do
    if e.key == key and t - e.at <= 3000 then return true end
  end
  return false
end

local function onOnline(d)
  local name = d.r:str()
  for _, s in ipairs(servers) do
    if s.muid == d.src then s.name = name; return end
  end
  -- A server that announced a new MUID under a known name (it restarted or changed MUID): follow it.
  for i, s in ipairs(servers) do
    if s.name == name and d.dst == BROADCAST and op == nil then
      local same = 0
      for _, o in ipairs(servers) do if o.name == name then same = same + 1 end end
      if same == 1 then s.muid = d.src; if i == selected then status(name .. " has a new MUID") end; return end
    end
  end
  if #servers < MAX_SERVERS then table.insert(servers, { muid = d.src, name = name }) end
end

local function handle(d)
  if d.type == MSG.ONLINE then
    onOnline(d)
    showServers() -- show servers as they answer, not only when discovery ends
    return
  end
  if not op or d.tid ~= op.tid or d.dst ~= myMuid then return end
  local s = server()
  if not s or d.src ~= s.muid then return end         -- only the server we asked

  if d.type == MSG.STATUS then
    local requestType, code, recordId = d.r:n(1), d.r:n(1), d.r:n(3)
    if op.kind == "count" then
      if code == 1 then return store(0) end            -- no snapshots yet
      return finish("Save failed: " .. (STATUS_NAME[code] or code))
    elseif op.kind == "store" then
      if code == 0 then return finish(op.name .. " saved as #" .. recordId .. " on " .. s.name) end
      return finish("Save failed: " .. (STATUS_NAME[code] or code))
    elseif op.kind == "query" then
      page.total = 0
      showPage()
      return finish(code == 1 and ("No snapshots on " .. s.name) or ("Load failed: " .. (STATUS_NAME[code] or code)))
    elseif op.kind == "retrieve" then
      return finish("Load failed: " .. (STATUS_NAME[code] or code))
    end

  elseif d.type == MSG.QUERY_RESULT and (op.kind == "query" or op.kind == "count") then
    local total, index, recordId = d.r:n(2), d.r:n(2), d.r:n(3)
    local rec = d.r:record()
    rec.recordId = recordId
    if op.kind == "count" then return store(total) end
    if not page.results[index] then op.got = op.got + 1 end
    page.results[index] = rec
    page.total = total
    op.deadline = now() + REPLY_WAIT
    if op.got >= math.min(op.start + ROWS, total) - op.start then
      showPage()
      finish(string.format("%d snapshot(s) on %s. Tap one to load it.", total, s.name))
    end

  elseif d.type == MSG.STORE_ACK and op.kind == "store" then
    local nextBlock = d.r:n(2)
    if nextBlock == op.want then sendStoreBlock(nextBlock) end -- other acks are late or duplicated

  elseif d.type == MSG.RETRIEVE_HEADER and op.kind == "retrieve" then
    if not op.header then
      local h = { recordId = d.r:n(3) }
      local rec = d.r:record()
      h.name = rec.name
      h.size = d.r:n(3)
      h.numBlocks = d.r:n(2)
      h.crc = d.r:n(5)
      op.header = h
    end
    op.deadline = now() + REPLY_WAIT
    retrieveAck(op.next)

  elseif d.type == MSG.RETRIEVE_BLOCK and op.kind == "retrieve" and op.header then
    local index, size = d.r:n(2), d.r:n(2)
    local data = d.r:bytes(size)
    op.deadline = now() + REPLY_WAIT
    if index == op.next then
      for i = 1, #data do op.data[#op.data + 1] = data[i] end
      op.next = op.next + 1
      retrieveAck(op.next)                              -- after the last block: "all received"
      if op.next == op.header.numBlocks then
        if #op.data ~= op.header.size then return finish("Load failed: size mismatch") end
        if crc32(op.data) ~= op.header.crc then return finish("Load failed: checksum mismatch") end
        local ok, err = applySnapshot(op.data)
        return finish(ok and ("Loaded " .. op.header.name .. " (#" .. op.recordId .. ")") or ("Load failed: " .. err))
      end
    elseif index == op.next - 1 then
      retrieveAck(op.next)                              -- the server resent a block: repeat the ack
    end
  end
end

function onReceiveMIDI(message, connections)
  if type(message) ~= "table" or #message < 4 then return end
  local first = floor(tonumber(message[1]) or 0)
  if first ~= 0xF0 and first ~= 0x7E then return end -- not SysEx (0x7E: framing stripped by the host)
  local m = normalize(message)
  local d = decode(m)
  if not d then
    if m[2] == 0x7E and m[4] == SUB_ID then log("ignored a malformed MBSP message of " .. #m .. " bytes") end
    return
  end
  log(string.format("rx type %d from %s to %s, tid %d", d.type, hex(d.src, 7), hex(d.dst, 7), d.tid))
  if d.src == myMuid then
    if isEcho(m) then log("  our own message, echoed back: ignored"); return end
    -- Another device is using our MUID: abandon what we were doing and draw a new one.
    myMuid = randomMuid()
    setText("muidLabel", "MUID " .. hex(myMuid, 7))
    finish("MUID collision: now using " .. hex(myMuid, 7))
    return
  end
  if d.dst ~= myMuid and d.dst ~= BROADCAST then return end
  local ok, err = true, nil
  if pcall then ok, err = pcall(handle, d) else handle(d) end
  if not ok then log("  error: " .. tostring(err)); finish("Bad reply: " .. tostring(err)) end
end

------------------------------------------------------------------------------
-- Timers
------------------------------------------------------------------------------
function update()
  if not op or now() < op.deadline then return end
  if op.kind == "discover" then
    log("discovery finished: " .. #servers .. " server(s)")
    showServers()
    if #servers == 0 then return finish("No MBSP servers answered") end
    -- Choose a server automatically only when it is unambiguous (one server, or the old choice).
    if #servers == 1 then selected = 1 end
    showServers()
    finish(#servers .. " server(s) found" .. (selected and "" or ". Tap one to choose it."))
  elseif op.kind == "store" and op.retries < MAX_RETRIES then
    op.retries = op.retries + 1                         -- no ack: resend the last message
    op.deadline = now() + ACK_TIMEOUT
    send(op.last[1], server().muid, op.tid, op.last[2])
  elseif op.kind == "query" and op.got > 0 then
    showPage()
    finish("Some results were lost. Tap Load to try again.")
  else
    finish((op.kind == "retrieve" and "Load" or op.kind == "query" and "Load" or "Save") .. " failed: no reply")
  end
end

------------------------------------------------------------------------------
-- Buttons
------------------------------------------------------------------------------
function onReceiveNotify(action, index)
  if action == "discover" then
    if op then return end
    discover()
  elseif action == "server" then
    if servers[index] then selected = index; showServers(); status("Using " .. servers[index].name) end
  elseif op then
    status("Busy, please wait...")
  elseif action == "save" then
    save()
  elseif action == "load" then
    if not server() then return status("Discover and choose a server first") end
    sendQuery(0)
  elseif action == "prev" then
    if server() and page.start > 0 then sendQuery(math.max(0, page.start - ROWS)) end
  elseif action == "next" then
    if server() and page.start + ROWS < page.total then sendQuery(page.start + ROWS) end
  elseif action == "row" then
    local r = page.results[page.start + index - 1]
    if r and server() then retrieve(r.recordId) end
  end
end

function init()
  math.randomseed(now() + floor(os and os.time and os.time() or 0))
  myMuid = randomMuid()
  tidCounter = math.random(0, 16383)
  showServers()
  showPage()
  setText("muidLabel", "MUID " .. hex(myMuid, 7))
  discover()
end
