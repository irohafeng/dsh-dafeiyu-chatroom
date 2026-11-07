// 房间的存档：一间一个目录，根目录一张总表。
//
// 为什么不是一个大 jsonl：房间现在能被建立、改名、解散，还会不止一间。
// 单文件装不下这些——改名要记名字链，解散要留墓碑，多间要分开算。
//
// 布局：
//   <root>/index.json                总表：每间房的名字、生命周期、改名链、成员、席位
//   <root>/<roomId>/messages.jsonl   这一间的消息流
//
// roomId 是稳的（建了就定），名字是可改的。库要能带走，所以 root 可配。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const BOM = '\uFEFF'

export function defaultRoot() {
  return join(homedir(), '.dsh', 'dafeiyu-chatroom', 'rooms')
}

export const ALIVE = 'alive'
export const DISPOSED = 'disposed'

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const o = JSON.parse(readFileSync(file, 'utf8').replace(BOM, ''))
    return o && typeof o === 'object' ? o : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    try {
      writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    } catch {
      /* 写不了就交给上层 */
    }
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 没留下临时文件就算了 */
    }
  }
}

export const indexPath = (root) => join(root, 'index.json')
export const messagesPath = (root, id) => join(root, String(id), 'messages.jsonl')

export function loadIndex(root) {
  const o = readJson(indexPath(root), {})
  return { rooms: o && typeof o.rooms === 'object' && o.rooms ? o.rooms : {} }
}

export function saveIndex(root, index) {
  writeJson(indexPath(root), index)
}

function newRoomId(rooms) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  for (let i = 0; i < 200; i++) {
    const id = `r-${day}-${Math.floor(100 + Math.random() * 900)}`
    if (!rooms[id]) return id
  }
  return `r-${day}-${Date.now() % 1000}`
}

/** 这个名字有没有被别的「开着的」房间占着。散了的碑不算——名字可以再用，但别同时用。 */
export function nameTaken(index, name, exceptId = '') {
  const want = String(name || '').trim()
  if (!want) return null
  return (
    Object.values(index.rooms || {}).find(
      (r) => r.status === ALIVE && r.name === want && String(r.id) !== String(exceptId)
    ) || null
  )
}

/**
 * 按名字或 id 找一间。先找 id，再找现在的名字，最后找改名前用过的名字。
 *
 * 同名会并存：旧的散了留碑，新的又起了同一个名字。所以先在「开着的」里挑，
 * 挑不到才退回碑——否则按名字找会先撞上那块碑，回一句「已解散、没席位」。
 */
export function findRoom(index, q) {
  const want = String(q || '').trim().replace(/^《|》$/g, '')
  if (!want) return null
  const rooms = index.rooms || {}
  if (rooms[want]) return rooms[want]

  const all = Object.values(rooms)
  const pick = (list) =>
    list.find((r) => r.name === want) ||
    list.find((r) => Array.isArray(r.renamedFrom) && r.renamedFrom.includes(want)) ||
    null

  return pick(all.filter((r) => r.status === ALIVE)) || pick(all)
}

export function createRoom(root, name, opts = {}) {
  const index = loadIndex(root)
  const id = newRoomId(index.rooms)
  const now = new Date().toISOString()
  const room = {
    id,
    name: String(name || '').trim() || `房间${Object.keys(index.rooms).length + 1}`,
    createdAt: now,
    status: ALIVE,
    renamedFrom: [],
    members: Array.isArray(opts.members) ? opts.members.map(String) : [],
    seats: {},
  }
  index.rooms[id] = room
  saveIndex(root, index)
  mkdirSync(join(root, id), { recursive: true })
  return room
}

export function renameRoom(root, room, newName) {
  const name = String(newName || '').trim()
  if (!name) return { ok: false, text: '新名字不能为空。' }
  if (room.name === name) return { ok: false, text: `这间本来就叫《${name}》。` }
  const index = loadIndex(root)
  const hit = index.rooms[room.id]
  if (!hit) return { ok: false, text: '找不到这间房。' }
  const old = hit.name
  // 去重：改两次名会留下重复，顺着旧名找就会绕圈。
  // 顺序保留「最近的在前」，同一个老名字只留一次。
  const prev = Array.isArray(hit.renamedFrom) ? hit.renamedFrom : []
  hit.renamedFrom = [old, ...prev.filter((n) => n && n !== old)].filter((n, i, a) => a.indexOf(n) === i)
  hit.name = name
  hit.renamedAt = new Date().toISOString()
  saveIndex(root, index)
  return { ok: true, text: `《${old}》改名为《${name}》了。`, old, next: name, room: hit }
}

/**
 * 解散：消息真删，只留一条碑。
 *
 * 碑里留名字、什么时候散的、有谁在——删掉的是话，不是「这间房存在过」这件事。
 * 屋里可能一个人都不在，删完就没人知道它曾经存在；留下的碑就是给后来的会话看的。
 */
export function disposeRoom(root, room) {
  const index = loadIndex(root)
  const hit = index.rooms[room.id]
  if (!hit) return { ok: false, text: '找不到这间房。' }
  hit.status = DISPOSED
  hit.disposedAt = new Date().toISOString()
  delete hit.seats // 席位跟着会话走，房没了就没有席位
  saveIndex(root, index)
  // 消息真删：先生要的是「真的删除该房间」
  let removed = false
  try {
    rmSync(join(root, hit.id), { recursive: true, force: true })
    removed = true
  } catch {
    /* 删不掉就把碑留着，让人看得见它还占着地方 */
  }
  return {
    ok: true,
    text: `《${hit.name}》解散了${removed ? '，消息已删掉' : '（目录没能删干净）'}，只留了一块碑。`,
    room: hit,
  }
}

export function appendMessage(root, roomId, rec) {
  const file = messagesPath(root, roomId)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
  return rec
}

export function readMessages(root, roomId, limit = 60) {
  const file = messagesPath(root, roomId)
  try {
    if (!existsSync(file)) return []
    const out = []
    for (const line of readFileSync(file, 'utf8').replace(BOM, '').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 坏行跳过 */
      }
    }
    return limit > 0 ? out.slice(-limit) : out
  } catch {
    return []
  }
}

/** 席位：这间会话能不能在这屋里说话。席位跟会话，成员跟人。 */
export function giveSeat(root, room, person, sessionId) {
  const index = loadIndex(root)
  const hit = index.rooms[room.id]
  if (!hit) return { ok: false }
  const persons = new Set(hit.members || [])
  persons.add(String(person))
  hit.members = [...persons]
  const seats = { ...(hit.seats || {}) }
  const list = Array.isArray(seats[person]) ? seats[person] : seats[person] ? [seats[person]] : []
  seats[person] = [String(sessionId), ...list.filter((x) => String(x) !== String(sessionId))].slice(0, 10)
  hit.seats = seats
  saveIndex(root, index)
  return { ok: true, room: hit }
}

/** 这间会话在这间屋里叫什么。没有席位就返回空。 */
export function personOf(room, sessionId) {
  const id = String(sessionId || '')
  if (!id) return ''
  for (const [person, list] of Object.entries(room.seats || {})) {
    const ids = Array.isArray(list) ? list : [list]
    if (ids.map(String).includes(id)) return person
  }
  return ''
}

/** 这间会话在这间屋里坐过的名字（有席位才有）。 */
export function seatsOf(room, person) {
  const raw = (room.seats || {})[person]
  return Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
}

/**
 * 摘掉一个死掉的席位：会话已经没了，席位不该还挂着它。
 *
 * 只摘会话，不动成员——人还是这间屋的人，等新会话进来重新挂席位。
 * 摘掉之后席位空了，就把这个名字从席位表里删掉，别留个空壳。
 */
export function removeSeat(root, room, person, sessionId) {
  const index = loadIndex(root)
  const hit = index.rooms[room.id]
  if (!hit) return { ok: false, removed: false }
  const seats = { ...(hit.seats || {}) }
  const raw = seats[person]
  const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String)
  if (!ids.includes(String(sessionId))) return { ok: true, removed: false }
  const left = ids.filter((x) => x !== String(sessionId))
  if (left.length) seats[person] = left
  else delete seats[person]
  hit.seats = seats
  saveIndex(root, index)
  return { ok: true, removed: true }
}

/** 会话 id 的短写法：认不出名字时拿它当临时称呼，得真的分得开。 */
export const shortId = (sessionId) =>
  String(sessionId || '')
    .replace(/^session-/, '')
    .slice(0, 8)

/**
 * 认领：把这个会话挂到一个名字下，不填的话就先挂成无名——
 * 无名也有席位，等它开口报了名字再对上人。
 */
export function claimName(root, room, sessionId, person) {
  const index = loadIndex(root)
  const hit = index.rooms[room.id]
  if (!hit) return { ok: false }
  const seats = { ...(hit.seats || {}) }
  const who = String(person || '').trim() || `（待认领 ${shortId(sessionId)}）`
  // 同一个会话不该同时挂在两个名字下：先把旧的摘掉
  for (const [name, list] of Object.entries(seats)) {
    if (name === who) continue
    const ids = (Array.isArray(list) ? list : [list]).map(String)
    if (ids.includes(String(sessionId))) {
      const left = ids.filter((x) => x !== String(sessionId))
      if (left.length) seats[name] = left
      else delete seats[name]
    }
  }
  const list = Array.isArray(seats[who]) ? seats[who] : seats[who] ? [seats[who]] : []
  seats[who] = [String(sessionId), ...list.filter((x) => String(x) !== String(sessionId))].slice(0, 10)
  hit.seats = seats
  if (person) {
    const persons = new Set(hit.members || [])
    persons.add(String(person))
    hit.members = [...persons]
  }
  saveIndex(root, index)
  return { ok: true, room: hit, person: person ? String(person) : '' }
}

/** 这间会话的认领是不是还没对上名字。 */
export function isUnclaimed(room, sessionId) {
  return !personOf(room, sessionId)
}
