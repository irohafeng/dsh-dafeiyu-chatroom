// dsh-dafeiyu-chatroom —— 房间。
//
// 一间房 = 一个目录（消息流）+ 总表里一行（名字、生命周期、改名链、成员、席位）。
// 席位跟会话：这间会话能不能在这屋里说话；成员跟人：库里那条「我是《X》的成员」。
// 新会话没席位，但仍然是成员——两层不矛盾，这样会话 id 换了也不会把「人」弄丢。
//
// 早先叫 qq-bridge：最早想接 QQ，后来发现官方平台的 bot 之间互相看不见，就在
// DSH 里自己搭屋子。协议那层早就不用了，名字也跟着改成 chatroom。

import { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as rooms from './rooms.js'

export const name = 'dafeiyu-chatroom'
export const inject = ['tools', 'sessionController']

const HERE = dirname(fileURLToPath(import.meta.url))
const LOCAL_CONFIG = join(HERE, '..', 'config.local.json')
const DIAG = process.env.DAFEIYU_CHATROOM_DIAG || join(tmpdir(), 'dafeiyu-chatroom-diag.log')

function diag(msg) {
  try {
    appendFileSync(DIAG, `${new Date().toISOString()}  ${msg}\n`)
  } catch {
    /* 日志写不了就算了 */
  }
}

const DEFAULTS = {
  root: '', // 房间根目录，默认 ~/.dsh/dafeiyu-chatroom/rooms
  human: '', // 屋里那个真人叫什么；空着就用这台机器的用户名
  autoWakeTurns: 10,
  agentGapMs: 4000, // agent 之间叫醒前压一下，给人留看和插话的时间
  agentGapPer100: 1000, // 上一条每 100 字再加这么多
  agentGapMaxMs: 20000, // 压的上限
  waitMs: 15000, // room wait 默认等多久
  waitMaxMs: 30000, // room wait 最多的上限
  // 人随口说的话：同一个人这么快之内只叫一次，期间攒着的到点一次叫完。
  // 一次叫醒就是一轮整段上下文重发，所以「不重复叫」比「早点叫」值钱。
  wakeGapMs: 60000,
  // 人说完话先等多久再叫：0=立刻叫一次，然后进上面的冷却。
  humanLeadGapMs: 0,
}

const FIELDS = {
  action: {
    type: 'string',
    required: true,
    enum: ['say', 'read', 'info', 'list', 'create', 'rename', 'dispose', 'join', 'wake', 'wait', 'invite', 'online'],
    description:
      'say=说一句；read=看没看过的话；info=这间房的状况；list=列出所有房间；create=建一间；rename=改名；dispose=解散；join=让这间会话入座；wake=叫醒某人；wait=等下一句（最多十几秒）；invite=请另一个人进来（to 填名字）；online=看谁现在在线。',
  },
  room: { type: 'string', description: '作用在哪间（名字或 id）。不给就用这间会话的默认房。' },
  text: { type: 'string', description: 'say 说哪句；rename 的新名字。' },
  name: { type: 'string', description: 'create 的房间名；join 时我的名字。' },
  session: { type: 'string', description: 'wake 时叫醒哪个会话。' },
  expects: { type: 'boolean', description: '是不是抛出去等人接。是才会叫醒人。' },
  to: { type: 'string', description: '收件人。定向叫醒他，并记成「在等回音」——他回了会叫醒你。' },
  wake: { type: 'boolean', description: 'false 表示只记下，不叫醒任何人。' },
  steer: {
    type: 'boolean',
    description: 'true 表示插话（更正、改口令），投进对方正在跑的那一轮；默认排队。',
  },
  n: { type: 'number', description: 'read 看几条，默认 8。' },
  ms: { type: 'number', description: 'wait 最多等多少毫秒，默认 15000，最多 30000。' },
  from: { type: 'string', description: 'wait 等谁，默认等最后说话的人。' },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
  },
}

const renderResult = (_args, value) => [
  { type: 'text', text: typeof value?.message === 'string' && value.message ? value.message : '(没有输出)' },
]

export function apply(ctx, config = {}) {
  const disposers = []
  const keep = (d) => {
    if (typeof d === 'function') disposers.push(d)
  }

  const readLocal = () => {
    try {
      if (!existsSync(LOCAL_CONFIG)) return {}
      const o = JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8').replace(/^\uFEFF/, ''))
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }
  const conf = () => ({ ...DEFAULTS, ...(config || {}), ...readLocal() })
  const root = () => conf().root || rooms.defaultRoot()
  // 屋里那个真人叫什么：配置优先，没配就用这台机器的用户名，取不到再退回「用户」。
  const humanName = () => {
    const set = String(conf().human || '').trim()
    if (set) return set
    try {
      const who = userInfo().username
      if (who) return who
    } catch {
      /* 取不到系统用户名 */
    }
    return '用户'
  }
  const isHuman = (who) => String(who || '') === humanName()

  // ── 状态：谁在里面、谁看到哪儿、哪间是这间会话的默认房 ───────────────────
  const stateFile = () => join(dirname(root()), 'state.json')
  const readState = () => {
    try {
      return JSON.parse(readFileSync(stateFile(), 'utf8').replace(/^\uFEFF/, '')) || {}
    } catch {
      return {}
    }
  }
  const writeState = (patch) => {
    try {
      mkdirSync(dirname(stateFile()), { recursive: true })
      writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }), 'utf8')
    } catch {
      /* 记不住就算了，别为了记一笔把说话弄坏 */
    }
  }

  const defaultRoomFor = (sessionId) => {
    const map = readState().defaultRoom || {}
    return map[String(sessionId || '')] || ''
  }
  const setDefaultRoom = (sessionId, roomId) => {
    if (!sessionId || !roomId) return
    writeState({ defaultRoom: { ...(readState().defaultRoom || {}), [String(sessionId)]: String(roomId) } })
  }

  const seenId = (roomId, person) => ((readState().seen || {})[String(roomId)] || {})[String(person)] || ''
  const setSeen = (roomId, person, msgId) => {
    const seen = { ...(readState().seen || {}) }
    seen[String(roomId)] = { ...(seen[String(roomId)] || {}), [String(person)]: String(msgId) }
    writeState({ seen })
  }

  // ── 找房间 ────────────────────────────────────────────────────────────────
  const resolveRoom = (q, sessionId, preloaded) => {
    const index = preloaded || rooms.loadIndex(root())
    const want = String(q || '').trim()
    if (want) {
      const hit = rooms.findRoom(index, want)
      if (hit) return hit
    }
    const own = defaultRoomFor(sessionId)
    if (own && index.rooms[own]) {
      // 默认那间被解散了就别再往里说话：清掉这间会话的默认，往下走
      if (index.rooms[own].status === rooms.ALIVE) return index.rooms[own]
      if (sessionId) setDefaultRoom(sessionId, '')
    }
    const alive = Object.values(index.rooms).filter((r) => r.status === rooms.ALIVE)
    return alive.length === 1 ? alive[0] : null
  }

  const aliveRooms = () => Object.values(rooms.loadIndex(root()).rooms).filter((r) => r.status === rooms.ALIVE)

  /**
   * 这个人是谁（按记忆库认，认不到就空）。
   *
   * 「上次在哪间屋」得按人存，不能按会话存——先生每开一个新会话 id 就换了，
   * 按会话存等于每次都从头。
   */
  const recallKey = (sessionId) => {
    try {
      const st = join(homedir(), '.dsh', 'dafeiyu-memory', 'state.json')
      if (!existsSync(st)) return ''
      const o = JSON.parse(readFileSync(st, 'utf8').replace(/^\uFEFF/, ''))
      const dir = o && o.sessionStores ? o.sessionStores[String(sessionId || '')] : ''
      if (!dir) return ''
      const metaFile = join(dir, 'meta.json')
      if (!existsSync(metaFile)) return ''
      const m = JSON.parse(readFileSync(metaFile, 'utf8').replace(/^\uFEFF/, ''))
      return m && m.id ? String(m.id) : ''
    } catch {
      return ''
    }
  }

  /** 「这个人上次在哪间」，按人记：人是记忆库的 id，会话 id 换了它还在。 */
  const rememberRoom = (who, roomId) => {
    const id = String(who || '')
    if (!id || !roomId) return
    const map = readState().lastRoom || {}
    if (map[id] === String(roomId)) return
    writeState({ lastRoom: { ...map, [id]: String(roomId) } })
  }

  /**
   * 记忆插件那份「会话 → 库」的映射，翻过来用：库名就是人。
   *
   * 每次现读，不缓存：换库、改名那边都会更新这份文件。
   * 库不在（拔盘）就返回空——这时房间认不出人，也是设计里认了的。
   */
  const memoryMap = () => {
    try {
      const st = join(homedir(), '.dsh', 'dafeiyu-memory', 'state.json')
      if (!existsSync(st)) return []
      const o = JSON.parse(readFileSync(st, 'utf8').replace(/^\uFEFF/, ''))
      const stores = o && o.sessionStores && typeof o.sessionStores === 'object' ? o.sessionStores : {}
      const names = new Map()
      for (const dir of new Set(Object.values(stores))) {
        try {
          const m = JSON.parse(readFileSync(join(String(dir), 'meta.json'), 'utf8').replace(/^\uFEFF/, ''))
          if (m && m.name) names.set(String(dir), String(m.name))
        } catch {
          /* 库不在 */
        }
      }
      const out = []
      for (const [sid, dir] of Object.entries(stores)) {
        const name = names.get(String(dir))
        if (name) out.push({ sessionId: String(sid), name })
      }
      return out
    } catch {
      return []
    }
  }

  /**
   * 这个人现在活着的会话，最近的排前面。
   *
   * 来源两处：记忆映射（库名就是人）和屋里席位。都要现探——表可以见过期，会话不会。
   */
  const onlineSessions = async (person) => {
    const want = String(person || '').trim().toLowerCase()
    const hits = new Set()
    if (want) {
      for (const e of memoryMap()) if (e.name.toLowerCase() === want) hits.add(e.sessionId)
      for (const r of Object.values(rooms.loadIndex(root()).rooms)) {
        if (r.status !== rooms.ALIVE) continue
        for (const id of rooms.seatsOf(r, person)) hits.add(String(id))
      }
    }
    if (!hits.size) return []
    const updated = new Map()
    try {
      const list = await ctx.sessionController.list({}, new AbortController().signal)
      for (const s of (list && list.items) || []) updated.set(String(s.sessionId), Number(s.updatedAt) || 0)
    } catch {
      /* 查不到活跃时间就不排序 */
    }
    const out = []
    for (const id of hits) {
      const p = await probeSession(id)
      if (p.alive === true) out.push({ sessionId: id, at: updated.get(id) || 0 })
    }
    out.sort((a, b) => b.at - a.at)
    return out
  }

  /**
   * 补票：早先入座的会话没有 lastRoom 这一笔。
   *
   * 席位本身就是事实——这间会话坐在这间屋里，不必再问它是谁。把它翻成
   * 「人 → 上次哪间」，人用记忆库的 id。一个人同时在几间屋里都有席位时，
   * 取最近有人说话的那间：这是把已有的先后摆出来，不是在猜。
   *
   * 不补票，早先入过座的人换新会话就领不进来——join 才写 lastRoom，
   * 而那时还没有这一行代码。
   */
  const backfillLastRoom = () => {
    const index = rooms.loadIndex(root())
    const map = { ...(readState().lastRoom || {}) }
    const hits = {}
    for (const r of Object.values(index.rooms)) {
      if (r.status !== rooms.ALIVE) continue
      for (const ids of Object.values(r.seats || {})) {
        for (const sid of Array.isArray(ids) ? ids : [ids]) {
          const who = recallKey(sid)
          if (who) (hits[who] = hits[who] || []).push(r)
        }
      }
    }
    let changed = false
    for (const [who, list] of Object.entries(hits)) {
      if (map[who] && list.some((r) => r.id === map[who])) continue
      let pick = list[0]
      if (list.length > 1) {
        const lastAt = (r) => {
          const all = rooms.readMessages(root(), r.id, 0)
          return all.length ? String(all[all.length - 1].at) : ''
        }
        pick = list.slice().sort((a, b) => lastAt(b).localeCompare(lastAt(a)))[0]
      }
      if (pick && map[who] !== pick.id) {
        map[who] = pick.id
        changed = true
      }
    }
    if (changed) writeState({ lastRoom: map })
    return map
  }

  /**
   * 领进来：这间会话从没进过这间屋时，把它领到上次那间去。
   *
   * 只做「领」，不问它叫什么——名字等它开口再认领。上次那间散了或没了，
   * 不猜、不挪，直说并把能进的屋子列出来。
   */
  const adopt = (sessionId) => {
    const index = rooms.loadIndex(root())
    const alive = Object.values(index.rooms).filter((r) => r.status === rooms.ALIVE)
    if (!alive.length) return null

    // 已经在某间里坐着的，不用领
    for (const r of alive) if (rooms.personOf(r, sessionId)) return { room: r, adopted: false }

    const who = recallKey(sessionId)
    const lastId = who ? backfillLastRoom()[who] || '' : ''
    if (!lastId) return null

    const last = index.rooms[lastId]
    if (!last || last.status !== rooms.ALIVE) {
      const names = alive.map((r) => `《${r.name}》（${r.id}）`).join('、')
      return {
        gone: true,
        message: `你上次待的那间房（${lastId}）${last ? '已经解散了' : '已经不在了'}。现在能进的是：${names}。想进哪间说一声。`,
      }
    }

    rooms.claimName(root(), last, sessionId, '')
    // 领进来就算进门：这间是默认房，这个人的「上次」也跟着更新——不然下次还得靠兜底
    setDefaultRoom(sessionId, last.id)
    rememberRoom(who, last.id)
    return { room: rooms.loadIndex(root()).rooms[lastId], adopted: true }
  }

  // 老账先平一遍：早先入座的人没有 lastRoom，换个会话就领不进来
  try {
    backfillLastRoom()
  } catch (e) {
    diag('补 lastRoom 失败：' + (e && e.message))
  }

  // 还有一笔只写不读的旧账：lastFrom / lastAt，清一次
  try {
    const st = readState()
    if ('lastFrom' in st || 'lastAt' in st) {
      const next = { ...st }
      delete next.lastFrom
      delete next.lastAt
      // 直接整份写回：writeState 是合并，删掉键得靠替换
      writeFileSync(stateFile(), JSON.stringify(next), 'utf8')
    }
  } catch (e) {
    diag('清 lastFrom/lastAt 失败：' + (e && e.message))
  }

  // ── 叫醒 ──────────────────────────────────────────────────────────────────
  /**
   * 会话还在不在：true=在，false=确定没了，null=没探清。
   *
   * 只有「确定没了」才当死的处理（摘席位、跳过通知）——读不到可能只是暂时，
   * 把活会话当死的，比多试一次糟得多。
   */
  const probeSession = async (id) => {
    const sc = ctx.sessionController || {}
    try {
      // 老宿主有 inspect：能一眼看出会话还在不在
      if (typeof sc.inspect === 'function') {
        const ins = await sc.inspect(id)
        if (!ins || !Array.isArray(ins.events)) return { alive: false, why: '找不到' }
        return { alive: true }
      }
      // 新宿主没有 inspect：用 state 探，会话没了会抛 session/not-found
      if (typeof sc.state === 'function') {
        await sc.state({ sessionId: id }, new AbortController().signal)
        return { alive: true }
      }
      return { alive: null, why: '这个宿主没有可用的会话探测方法' }
    } catch (e) {
      const why = String((e && e.message) || '')
      const code = String((e && e.code) || '')
      return { alive: code === 'session/not-found' || /not found|找不到|不存在/i.test(why) ? false : null, why }
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 这个会话这一轮还在不在跑：true/false，查不到就 null。 */
  const sessionRunning = async (id) => {
    const sc = ctx.sessionController || {}
    if (typeof sc.state !== 'function') return null
    try {
      const st = await sc.state({ sessionId: String(id) }, new AbortController().signal)
      return !!(st && st.running)
    } catch {
      return null
    }
  }

  /** 这个人名下的会话还有没有一轮在跑：有一个在跑就是 true。 */
  const personRunning = async (room, person) => {
    let unknown = false
    for (const id of rooms.seatsOf(room, person)) {
      const r = await sessionRunning(id)
      if (r === true) return true
      if (r === null) unknown = true
    }
    return unknown ? null : false
  }

  /** 这个会话这一轮是不是还在跑：看 agent 的状态，拿不到就当空闲。 */
  const agentBusy = (id) => {
    try {
      const a = ctx.get && ctx.get('agents') ? ctx.get('agents').get(String(id)) : undefined
      return !!(a && a.status && a.status !== 'idle')
    } catch {
      return false
    }
  }

  /** 这个人名下的会话只要有在跑的，就是忙——这时候别排队叫他，等他收尾。 */
  const personBusy = (room, person) => rooms.seatsOf(room, person).some((id) => agentBusy(id))

  // 同一间同一个人上次被叫醒的时刻。冷却靠它：一分钟内不重复叫，攒着一次叫完。
  const lastWoke = new Map()
  const wokeKey = (roomId, person) => `${roomId}|${person}`
  const gapLeft = (roomId, person) => {
    const gap = Math.max(0, Number(conf().wakeGapMs ?? 60000))
    if (!gap) return 0
    const at = lastWoke.get(wokeKey(roomId, person)) || 0
    return Math.max(0, gap - (Date.now() - at))
  }

  const wakeOne = async (sessionId, person) => {
    const id = String(sessionId || '').trim()
    if (!id) return { ok: false, message: '要叫醒谁？给个会话 id。' }
    // 只有「真没了」才算死：读不到可能只是暂时的，别把活席位当死的摘了
    const p = await probeSession(id)
    if (p.alive === false) return { ok: false, gone: true, message: `没叫醒：会话 ${id} 找不到。` }
    if (p.alive === null) return { ok: false, gone: false, message: `没叫醒：会话 ${id} 读不到（${p.why}）。` }
    const probe = { sessionId: id, person }
    const note = wakeNote(probe)
    if (!note.count) return { ok: true, message: `${person} 没有新的话，就不叫了。` }
    const ago = note.lastAt ? Math.max(0, Math.round((Date.now() - Date.parse(note.lastAt)) / 1000)) : 0
    // 只给事实：说话的人这一轮还在不在跑。要不要等，由读的人自己判断。
    const speaking = note.lastFrom && !isHuman(note.lastFrom) ? await personRunning(note.room, note.lastFrom) : null
    const fact =
      speaking === true
        ? `说这话的人这一轮还没收尾，可能还有下文；觉得没说完，用 room 工具 action 填 wait 等下一句。\n`
        : speaking === false
          ? '说这话的人这一轮已经收尾了。\n'
          : ''
    const text =
      `【房间】《${note.room.name}》里${note.lastFrom === person ? '有人接着说话' : note.lastFrom + ' 说了话'}，你可以过来看一眼——不是点名要你回答。\n` +
      `你上次看过之后，屋里多了 ${note.count} 条${ago ? `，最后一条 ${ago} 秒前` : ''}。想看就用 room 工具、action 填 read。\n` +
      fact +
      '\n要回就在屋里回（room 工具：read 看，say 说）——只在自己的会话里说，屋里的人看不见。\n' +
      (note.last && String(note.last.awaits || '') === String(person)
        ? '这条是在等你一声回音——应一句，屋里的人才好接着往下说。'
        : '看完你说也行，不说也行；不想说就什么也不用做，没人会等着你回。')
    try {
      // 叫之前先看他忙不忙：忙的话这条会排队，说话的人得知道，别以为没送到
      const busy = agentBusy(id)
      // 送到之前再核一次：通知生成这会儿，对方可能已经用 wait 看到了，别白叫一趟
      const again = wakeNote(probe)
      if (!again.count) return { ok: true, message: `${person} 没有新的话，就不叫了。` }
      const r = await ctx.sessionController.prompt(
        {
          requestId: 'room-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          sessionId: id,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal
      )
      lastWoke.set(wokeKey(again.room.id, person), Date.now())
      diag(`wake ${id} -> ${JSON.stringify(r)} busy=${busy}`)
      return {
        ok: true,
        busy,
        message: `叫了 ${person}（${busy ? '在忙，排着' : '空闲'}），它还有 ${again.count} 条没看。`,
      }
    } catch (e) {
      diag('wake 失败：' + (e && e.message))
      return { ok: false, message: `没叫醒：${e && e.message}` }
    }
  }

  /** 叫之前先知道：哪间、谁最后说话、他有多少没看。 */
  const wakeNote = ({ sessionId, person, room }) => {
    const r = room || resolveRoom('', sessionId)
    if (!r) return { count: 0 }
    const all = rooms.readMessages(root(), r.id, 0)
    const fresh = sinceId(all, seenId(r.id, person))
    return {
      room: r,
      count: fresh.length,
      lastFrom: fresh.length ? fresh[fresh.length - 1].from : '',
      lastAt: fresh.length ? fresh[fresh.length - 1].at : '',
      last: fresh.length ? fresh[fresh.length - 1] : null,
    }
  }

  const wakePerson = async (person, room, exceptSession) => {
    const list = rooms.seatsOf(room, person).filter((id) => id !== String(exceptSession || ''))
    let dropped = 0
    for (const id of list) {
      const r = await wakeOne(id, person)
      if (r.ok) return r
      diag(`叫 ${person} 没成（${id}）：${r.message}`)
      // 席位指着已经没了的会话：摘掉它，别让下回还往死处叫。不猜新会话的 id。
      if (r.gone) {
        try {
          if (rooms.removeSeat(root(), room, person, id).removed) {
            dropped++
            diag(`摘掉 ${person} 的死席位 ${id}`)
          }
        } catch (e) {
          diag(`摘席位失败（${person} ${id}）：` + (e && e.message))
        }
      }
    }
    const left = list.length - dropped
    const tail = dropped ? `（清掉了 ${dropped} 个死席位）` : ''
    const why = !list.length ? '还没有席位' : left ? '席位上的会话还在，但没叫醒' : '席位上的会话都不在了'
    return { ok: false, message: `${person} 叫不到——${why}${tail}` }
  }

  /**
   * 插话：把这一句直接投进对方正在跑的那一轮。
   *
   * 只标了 steer 才走这条路——打断是重手。正文写清谁说的、这是插话不是新任务、
   * 屋里已经有人回过什么；工具跑着的时候它也只会等下一步看见，弄不断。
   */
  const steerPerson = async (room, person, from, text) => {
    const all = rooms.readMessages(root(), room.id, 0)
    const recent = all
      .slice(-2)
      .map((r) => `${r.from}：${String(r.text || '').slice(0, 40)}`)
      .join('\n')
    const frame =
      `【房间】《${room.name}》插话——${from} 刚说的（这不是新任务，也不用重开手上的事）：\n` +
      text +
      (recent ? `\n\n屋里最近说过：\n${recent}` : '') +
      '\n\n要全貌用 room 工具、action 填 read；改不改你自己判断。'
    for (const id of rooms.seatsOf(room, person)) {
      const p = await probeSession(id)
      if (p.alive !== true) continue
      const running = await sessionRunning(id)
      const mode = running === true ? 'steer' : 'queue'
      try {
        await ctx.sessionController.prompt(
          {
            requestId: 'room-steer-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            sessionId: id,
            mode,
            content: [{ type: 'text', text: frame }],
          },
          new AbortController().signal
        )
        diag(`steer ${person} (${id}) mode=${mode}`)
        return { ok: true, mode, message: `${person}（${mode === 'steer' ? '插进正在跑的那一轮' : '空闲，直接投递'}）` }
      } catch (e) {
        diag(`插话 ${person}（${id}）失败：` + (e && e.message))
      }
    }
    return { ok: false, message: `${person} 叫不到——没有活着的会话` }
  }

  /**
   * 压着叫：agent 之间每叫一次先等一会儿，给人留看和插话的时间。
   *
   * 同一间同一人只压一个；后来的话把时间往后推——两条连着发，就只叫一次。
   * 人一开口，压着的全作废（他的消息会立刻叫醒别人）。
   */
  /**
   * 叫之前压多久：4 秒打底，上一条每 100 字加 1 秒，封顶 20 秒。
   *
   * 短话不拖，长话留够读完的时间。人的话不压，由调用处决定。
   */
  const paceFor = (text) => {
    const base = Math.max(0, Number(conf().agentGapMs) || 0)
    if (!base) return 0
    const per = Math.max(0, Number(conf().agentGapPer100 || 1000))
    const cap = Math.max(base, Number(conf().agentGapMaxMs) || 20000)
    const blocks = Math.floor(String(text || '').length / 100)
    return Math.min(cap, base + blocks * per)
  }

  const pendingWakes = new Map() // roomId -> Map<person, timer>
  /**
   * 压着叫：ms 之后叫一次，同一间同一人只有一个定时器。
   *
   * reset=true：后来的话把时间往后推（agent 之间连着说，只叫一次）；
   * reset=false：已经排着一个就让它排着，后来的话合并进去——人连着说几句，
   * 到点一次叫完，不再是一句一轮账单。
   */
  const scheduleWake = (room, person, ms, exceptSession, reset = true) => {
    const timers = pendingWakes.get(room.id) || new Map()
    const prev = timers.get(person)
    if (prev) {
      if (!reset) return false
      clearTimeout(prev)
    }
    const timer = setTimeout(async () => {
      timers.delete(person)
      if (!timers.size) pendingWakes.delete(room.id)
      try {
        await wakePerson(person, rooms.loadIndex(root()).rooms[room.id] || room, exceptSession)
      } catch (e) {
        diag(`压着叫 ${person} 出错：` + (e && e.message))
      }
    }, ms)
    timers.set(person, timer)
    pendingWakes.set(room.id, timers)
    return true
  }

  /**
   * 解散前挨个通知成员。
   *
   * 不能靠往消息流里写一句——消息流马上要被删掉，通知跟着一起没。
   * 所以走唤醒通路直接递到人眼前，顺便给他们一个改写记忆的钩子：
   * 库里那条「我在这间屋里」该改了。
   */
  const notifyDispose = async (room) => {
    const people = (room.members || []).filter((m) => m && !isHuman(m))
    const text =
      `【房间】《${room.name}》解散了。屋里的话已经删掉，总表里留了一块碑（名字和散的时间）。\n` +
      '如果你记忆里写着「我在这间屋里」，把那一条改掉——它已经不在了。'
    const out = []
    for (const person of people) {
      const ids = rooms.seatsOf(room, person)
      let done = false
      for (const id of ids) {
        // 先探一下：确定没了的会话不用再试，省一次白叫
        const p = await probeSession(id)
        if (p.alive === false) {
          diag(`解散通知 ${person}（${id}）跳过：会话不在了`)
          continue
        }
        try {
          await ctx.sessionController.prompt(
            {
              requestId: 'room-dispose-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
              sessionId: id,
              mode: 'queue',
              content: [{ type: 'text', text }],
            },
            new AbortController().signal
          )
          out.push({ name: person, ok: true })
          done = true
          break
        } catch (e) {
          diag(`解散通知 ${person}（${id}）失败：` + (e && e.message))
        }
      }
      if (!done) out.push({ name: person, ok: false })
    }
    return out
  }

  // ── 消息 ──────────────────────────────────────────────────────────────────
  const NOTE = '（房间）'

  const sinceId = (records, id) => {
    if (!id) return records.slice()
    const at = records.findIndex((r) => r.id === id)
    return at < 0 ? records.slice() : records.slice(at + 1)
  }

  const pendingOf = (records) => {
    const out = []
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      if (!r.expects && !r.awaits) continue
      const answered = records.slice(i + 1).some((l) => l.from !== r.from && l.from !== NOTE)
      if (!answered) out.push(r)
    }
    return out
  }

  const renderMsg = (records) => {
    if (!records.length) return '（这间屋里还没有人说话）'
    return records
      .map((r) => {
        const waiting = (r.expects || r.awaits) && !records.some((l) => l.at > r.at && l.from !== r.from && l.from !== NOTE)
        const hang = waiting ? (r.awaits && !r.expects ? '  ← 等一声回音' : '  ← 还没人接') : ''
        return `${r.from}：${r.text}${hang}`
      })
      .join('\n')
  }

  const sayInRoom = async (room, from, text, opts = {}) => {
    const human = isHuman(from)
    const expects = typeof opts.expects === 'boolean' ? opts.expects : human
    const before = rooms.readMessages(root(), room.id, 0)
    const pendingBefore = new Set(pendingOf(before).map((r) => r.id))
    const body = String(text || '').trim()
    if (!body) return { ok: false, message: '要说的话是空的。' }
    const rec = {
      id: 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      from: String(from),
      text: body,
    }
    if (expects) rec.expects = true
    // 定向叫了谁，就在等谁一声——回音到了要把说话的人叫醒，别靠谁记得标。
    // 但要是这条本身就是在回他一条还挂着的话，这回就销账，不再记成新的一轮，免得礼貌绕圈。
    if (opts.to && opts.wake !== false) {
      const want = String(opts.to).trim()
      const answering = before.some((r) => pendingBefore.has(r.id) && String(r.from) === want)
      if (want && !answering) rec.awaits = want
    }
    rooms.appendMessage(root(), room.id, rec)

    const budget = Number(conf().autoWakeTurns ?? 10)
    const st = readState()
    let turns = Number(st.agentTurns || 0)
    turns = human ? 0 : turns + 1
    writeState({ agentTurns: turns })
    if (human) setSeen(room.id, from, rec.id)

    const others = (room.members || []).filter((m) => m && m !== from)

    let targets = []
    if (opts.wake === false) targets = []
    else if (Array.isArray(opts.wake) && opts.wake.length) targets = opts.wake.map(String)
    else if (!expects) targets = []
    else {
      targets = others
      if (!human && turns > budget) targets = []
    }

    // 有人接了还挂着的话：把那条的作者叫回来。不靠回哪一条，靠屋里的事实。
    // wake:false 说了「一个人都不叫」，那就真的一个都不叫，连回音也不叫。
    const must = new Set() // 事实层的叫醒：点名、在等回音。不走冷却，一次都不省。
    if (opts.wake !== false && before.length) {
      const hangs = before.filter((r) => pendingBefore.has(r.id) && r.from && r.from !== from && !isHuman(r.from))
      for (const one of hangs) {
        if (!targets.includes(one.from)) targets.push(one.from)
        must.add(one.from)
      }
    }

    // 填了收件人：定向叫他一次。诊断、交接这类话本质是「办给她」，长得却像陈述，
    // 硬要写成问句才叫得动，就又回到「靠记得」——所以给一个明说的口子。
    if (opts.wake !== false && opts.to) {
      const want = String(opts.to).trim()
      if (want && want !== from) {
        targets = [...new Set([want, ...targets])]
        must.add(want)
      }
    }

    const woke = []
    const gap = human ? 0 : paceFor(body)
    const lead = human ? Math.max(0, Number(conf().humanLeadGapMs ?? 0)) : 0
    for (const person of targets) {
      if (opts.steer && !isHuman(person)) {
        const r = await steerPerson(room, person, from, body)
        woke.push({ name: person, ok: r.ok, steered: r.ok })
        continue
      }
      // 人随口说的话：叫一次，然后一分钟内不再叫他——攒着的到点一次叫完。
      // 他这一轮还在跑就先别叫：叫了也是排队，一句一轮是白付的钱。
      if (human && !must.has(person)) {
        const busy = personBusy(room, person)
        const left = Math.max(lead, busy ? 0 : gapLeft(room.id, person))
        if (busy || left > 0) {
          const ms = busy ? Math.max(left, Number(conf().wakeGapMs ?? 60000)) : left
          const armed = scheduleWake(room, person, ms, opts.selfSession, false)
          woke.push({ name: person, ok: true, delayed: ms, merged: !armed, busy })
          continue
        }
      }
      if (gap > 0) {
        scheduleWake(room, person, gap, opts.selfSession)
        woke.push({ name: person, ok: true, delayed: gap })
        continue
      }
      const r = await wakePerson(person, room, opts.selfSession)
      woke.push({ name: person, ok: r.ok, busy: !!r.busy })
    }
    return { ok: true, rec, woke, turns, capped: !human && turns > budget }
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────
  const loadDefineTool = () => {
    try {
      const req = createRequire(import.meta.url)
      const m = req('@deepseek-ai/dsh-tools')
      if (typeof m?.defineTool === 'function') return m.defineTool
    } catch (e) {
      diag('拿不到 defineTool：' + (e && e.message))
    }
    return null
  }

  const run = async (args, exec) => {
    const action = String(args?.action || 'read')
    const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
    const index = rooms.loadIndex(root())
    // 先看看要不要领进来：这间会话从没进过屋、但它这个人来过，就领到上次那间
    const adoptResult = sessionId ? adopt(sessionId) : null
    if (adoptResult && adoptResult.gone && !args?.room) {
      return { ok: false, message: adoptResult.message }
    }
    const index2 = adoptResult && adoptResult.adopted ? rooms.loadIndex(root()) : index
    const room = resolveRoom(args?.room, sessionId, index2)

    const needRoom = () => {
      if (room) return null
      const names = Object.values(index.rooms).filter((r) => r.status === rooms.ALIVE).map((r) => `《${r.name}》`)
      return {
        ok: false,
        message: names.length
          ? `不知道是哪间。现有的：${names.join('、')}——在 room 参数里写一个。`
          : '现在一间房都没有。建一间：action 填 create，name 填房间名。',
      }
    }

    switch (action) {
      case 'create': {
        // 建房子的人不进座：建是建，请是请。人建，然后单独请谁进来。
        const want = String(args?.name || '').trim()
        const clash = rooms.nameTaken(index, want)
        if (clash) return { ok: false, message: `已经有叫《${clash.name}》的房间了（${clash.id}）。换个名字，或者把它解散。` }
        const made = rooms.createRoom(root(), want, { members: [humanName()] })
        if (sessionId) setDefaultRoom(sessionId, made.id)
        return { ok: true, message: `建好了《${made.name}》（${made.id}）。要请谁进来，单独说。` }
      }

      case 'rename': {
        const miss = needRoom()
        if (miss) return miss
        const clash = rooms.nameTaken(index, String(args?.text || '').trim(), room.id)
        if (clash) return { ok: false, message: `已经有叫《${clash.name}》的房间了（${clash.id}）。` }
        const r = rooms.renameRoom(root(), room, args?.text)
        if (!r.ok) return { ok: false, message: r.text }
        rooms.appendMessage(root(), room.id, {
          id: 'm-' + Date.now().toString(36),
          at: new Date().toISOString(),
          from: NOTE,
          text: `这间房改名叫《${r.next}》了（原来叫《${r.old}》）。`,
        })
        return { ok: true, message: r.text }
      }

      case 'dispose': {
        const miss = needRoom()
        if (miss) return miss
        // 先通知人，再删：消息流一删，写进去的话也就没了
        const told = await notifyDispose(room)
        const r = rooms.disposeRoom(root(), room)
        // 房没了，本机记的账也一起清：看过哪儿、默认哪间、谁上次待哪间
        try {
          const st = readState()
          const seen = { ...(st.seen || {}) }
          delete seen[room.id]
          const drop = (map) => Object.fromEntries(Object.entries(map || {}).filter(([, v]) => String(v) !== room.id))
          writeState({ seen, defaultRoom: drop(st.defaultRoom), lastRoom: drop(st.lastRoom) })
        } catch (e) {
          diag('清解散后的本机账失败：' + (e && e.message))
        }
        const okNames = told.filter((t) => t.ok).map((t) => t.name)
        const failed = told.filter((t) => !t.ok).map((t) => t.name)
        return {
          ok: r.ok,
          message:
            r.text +
            (okNames.length ? ` 通知到：${okNames.join('、')}。` : '') +
            (failed.length ? ` 没通知到：${failed.join('、')}。` : ''),
        }
      }

      case 'list': {
        const all = Object.values(index.rooms)
        if (!all.length) return { ok: true, message: '一间房都还没有。' }
        const lines = all.map((r) => {
          const state = r.status === rooms.ALIVE ? '开着' : '已解散'
          const mine = rooms.personOf(r, sessionId)
          return `${r.id}  《${r.name}》  ${state}  成员 ${(r.members || []).length} 人${mine ? `（我是 ${mine}）` : ''}`
        })
        return { ok: true, message: lines.join('\n') }
      }

      case 'join': {
        const miss = needRoom()
        if (miss) return miss
        const person = String(args?.name || '').trim()
        if (!person) return { ok: false, message: '入座得说个名字：name 填你在屋里叫什么。' }
        if (!sessionId) return { ok: false, message: '现在拿不到会话，没法给这间入座。' }
        // 被领进来过的会话，本来挂在一个无名席位上：认领就是把那个席位改名，不留两份
        const was = rooms.personOf(room, sessionId)
        rooms.claimName(root(), room, sessionId, person)
        setDefaultRoom(sessionId, room.id)
        rememberRoom(recallKey(sessionId), room.id)
        // 新入座是事实，替所有人说一句——不用谁记得开口
        if (was !== person) {
          try {
            rooms.appendMessage(root(), room.id, {
              id: 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
              at: new Date().toISOString(),
              from: NOTE,
              text: `${person} 入座了。`,
            })
          } catch {
            /* 留一句留不下去也不挡入座 */
          }
        }
        return {
          ok: true,
          message:
            `入座了：《${room.name}》里你是 ${person}（${sessionId}）。` +
            '顺手在记忆里记一条：我在这间屋里，工具叫 room——下次会话换了 id，凭这条找回来。',
        }
      }

      case 'say': {
        const miss = needRoom()
        if (miss) return miss
        // 先看有没有人用这个名字：这间会话被领进来但还没报名字时，临时挂个名字说话
        const said = String(args?.name || '').trim()
        const person = rooms.personOf(room, sessionId) || (said ? `（待认领 ${rooms.shortId(sessionId)}）` : '')
        if (!person) return { ok: false, message: `这间会话在《${room.name}》里没有席位。先 join（name 填你的名字）。` }
        const r = await sayInRoom(room, person, args?.text, {
          expects: typeof args?.expects === 'boolean' ? args.expects : undefined,
          to: args?.to,
          steer: args?.steer === true,
          wake: args?.wake === false ? false : undefined,
          selfSession: sessionId,
        })
        if (!r.ok) return r
        const called = r.woke
          .filter((w) => w.ok)
          .map((w) =>
            w.steered
              ? `${w.name}（插话）`
              : w.delayed
                ? `${w.name}（压 ${Math.round(w.delayed / 1000)} 秒再叫）`
                : w.busy
                  ? `${w.name}（在忙，排着）`
                  : `${w.name}（空闲）`
          )
        const others = (room.members || []).filter((m) => m && m !== person)
        const tail = r.capped
          ? '；连着转了几轮，先不叫人了'
          : called.length
            ? `，叫了 ${called.join('、')}`
            : r.rec.expects
              ? '，挂着等人接'
              : others.length
                ? '，这句话一个人都不会被叫醒——要谁接就填 to，要谁都能接就填 expects'
                : '，没叫人'
        return { ok: true, message: `说了（${r.rec.id}）@《${room.name}》${tail}。` }
      }

      case 'read': {
        const miss = needRoom()
        if (miss) return miss
        const person = rooms.personOf(room, sessionId)
        const all = rooms.readMessages(root(), room.id, 0)
        const cap = Number(args?.n) > 0 ? Math.min(200, Number(args.n)) : 8
        const mark = (recs) => {
          if (person && recs.length) setSeen(room.id, person, recs[recs.length - 1].id)
        }
        const seen = person ? seenId(room.id, person) : ''
        if (!seen) {
          const tail = all.slice(-cap)
          mark(tail)
          return { ok: true, message: `@《${room.name}》\n` + renderMsg(tail) }
        }
        const unseen = sinceId(all, seen)
        if (!unseen.length) {
          return { ok: true, message: `@《${room.name}》\n` + renderMsg(all.slice(-Math.min(cap, 5))) + '\n（没有新的话）' }
        }
        const take = unseen.slice(0, cap)
        mark(take)
        const left = unseen.length - take.length
        return {
          ok: true,
          message: `@《${room.name}》\n` + renderMsg(take) + (left > 0 ? `\n（还有 ${left} 条没看，再 read 一次）` : ''),
        }
      }

      case 'wait': {
        const miss = needRoom()
        if (miss) return miss
        const person = rooms.personOf(room, sessionId)
        const all = rooms.readMessages(root(), room.id, 0)
        const anchor = all.length ? all[all.length - 1].id : ''
        // 默认等最后说话的那个人；自己最后说的就往前找一个别人
        const others = all.filter((r) => r.from !== person)
        const who = String(args?.from || '').trim() || (others.length ? others[others.length - 1].from : '')
        const capMs = Math.min(
          Number(conf().waitMaxMs) || 30000,
          Math.max(1000, Number(args?.ms) || Number(conf().waitMs) || 15000)
        )
        const deadline = Date.now() + capMs
        for (;;) {
          const now = rooms.readMessages(root(), room.id, 0)
          const at = anchor ? now.findIndex((r) => r.id === anchor) : -1
          const fresh = (at >= 0 ? now.slice(at + 1) : now).filter((r) => r.from !== person)
          if (fresh.length) {
            if (person) setSeen(room.id, person, fresh[fresh.length - 1].id)
            return { ok: true, message: `等到了，${who || '他'} 接着说：\n` + renderMsg(fresh) }
          }
          // 没有新话，但说话的人这一轮已经收尾：不用再等
          if (who && !isHuman(who)) {
            const still = await personRunning(room, who)
            if (still === false) return { ok: true, message: `${who} 这一轮已经收尾，没有下一句了。` }
          }
          if (Date.now() >= deadline) break
          await sleep(Math.min(1000, Math.max(200, deadline - Date.now())))
        }
        const secs = capMs % 1000 ? (capMs / 1000).toFixed(1) : String(capMs / 1000)
        return { ok: true, message: `等了 ${secs} 秒，没有下一句——大概说完了。` }
      }

      case 'info': {
        if (!room) {
          const all = Object.values(index.rooms).filter((r) => r.status === rooms.ALIVE)
          return { ok: true, message: all.length ? `现有的房：${all.map((r) => `《${r.name}》`).join('、')}` : '一间房都没有。' }
        }
        const msg = rooms.readMessages(root(), room.id, 0)
        const person = rooms.personOf(room, sessionId)
        return {
          ok: true,
          message: [
            `房间: 《${room.name}》（${room.id}）`,
            `根目录: ${root()}`,
            `状态: ${room.status === rooms.ALIVE ? '开着' : '已解散'}`,
            `消息: ${msg.length} 条`,
            `成员: ${(room.members || []).join('、') || '（还没有）'}`,
            `席位: ${Object.entries(room.seats || {}).map(([p, ids]) => `${p}=${ids.length} 间会话`).join('、') || '（还没有）'}`,
            `我是: ${person || '（这间没席位）'}`,
            room.renamedFrom && room.renamedFrom.length ? `改名前: ${room.renamedFrom.join(' → ')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }

      case 'wake': {
        const miss = needRoom()
        if (miss) return miss
        const target = String(args?.session || '').trim()
        if (target) {
          const person = rooms.personOf(room, target) || '你'
          const r = await wakeOne(target, person)
          if (!r.ok && r.gone && person !== '你') {
            try {
              rooms.removeSeat(root(), room, person, target)
              diag(`摘掉 ${person} 的死席位 ${target}`)
            } catch (e) {
              diag('摘席位失败：' + (e && e.message))
            }
          }
          // gone 是内部记号，工具输出只留 ok/message
          return { ok: r.ok, message: r.message }
        }
        const who = String(args?.name || '').trim()
        if (!who) return { ok: false, message: '叫谁？给个 name 或 session。' }
        return await wakePerson(who, room, sessionId)
      }

      case 'online': {
        const names = [...new Set(memoryMap().map((e) => e.name))]
        const rows = []
        for (const n of names) {
          const s = await onlineSessions(n)
          if (s.length) rows.push(`${n}（${s.length} 个会话活着）`)
        }
        return { ok: true, message: rows.length ? '在线：' + rows.join('、') : '没探到在线的会话。' }
      }

      case 'invite': {
        const miss = needRoom()
        if (miss) return miss
        const who = String(args?.to || '').trim()
        if (!who) return { ok: false, message: '请谁？to 填那个人的名字。' }
        if (isHuman(who)) return { ok: false, message: '人是屋里现成的，不用请；这个动作是叫另一个会话进来。' }
        const list = await onlineSessions(who)
        if (!list.length) {
          return { ok: false, message: `${who} 这会儿没有开着的会话，叫不到——得他自己进来，或者你说一句他在哪间会话。` }
        }
        const me = rooms.personOf(room, sessionId) || '有人'
        const text =
          `【房间】${me} 请你进《${room.name}》（${room.id}）。\n` +
          '想进就用 room 工具，action 填 join，room 填这间的名字或 id，name 填你在屋里的名字。不想进也行，不用回。'
        try {
          await ctx.sessionController.prompt(
            {
              requestId: 'room-invite-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
              sessionId: list[0].sessionId,
              mode: 'queue',
              content: [{ type: 'text', text }],
            },
            new AbortController().signal
          )
          diag(`invite ${who} -> ${list[0].sessionId}`)
          return { ok: true, message: `请了 ${who}（会话 ${list[0].sessionId}）。来不来他自己定。` }
        } catch (e) {
          return { ok: false, message: `请 ${who} 没成：${e && e.message}` }
        }
      }

      default:
        return { ok: false, message: `不认识的 action：${action}` }
    }
  }

  const defineTool = loadDefineTool()
  if (typeof defineTool === 'function' && typeof ctx.tools?.register === 'function') {
    try {
      const tool = defineTool({
        name: 'room',
        description: '房间：一间屋里几个人说话，我、别的 agent、用户。说话、看话都用它。',
        parameters: FIELDS,
        output: { schema: OUTPUT_SCHEMA, render: renderResult },
        execute: async (args, exec) => {
          try {
            return await run(args, exec)
          } catch (e) {
            diag('execute 抛错：' + (e && e.message))
            return { ok: false, message: `房间工具出错：${e && e.message}` }
          }
        },
      })
      keep(ctx.tools.register(tool))
      diag('register 成功：room')
    } catch (e) {
      diag('工具注册失败：' + (e && e.message))
    }
  }

  // ── 给界面用的接口 ────────────────────────────────────────────────────────
  const sendJson = (res, code, body) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    } catch {
      /* 对面已经断了 */
    }
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > 1e6) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const roomsBrief = () =>
    aliveRooms().map((r) => {
      const msgs = rooms.readMessages(root(), r.id, 0)
      return { id: r.id, name: r.name, lastAt: msgs.length ? msgs[msgs.length - 1].at : '', count: msgs.length }
    })

  const mountApi = (webCtx) => {
    const ws = webCtx && webCtx.webServer
    if (!ws || typeof ws.register !== 'function') {
      diag('webServer 还没到位')
      return
    }
    keep(
      ws.register({
        kind: 'exact',
        path: '/dafeiyu-chatroom/room',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              const url = new URL(req.url, 'http://localhost')
              const room = resolveRoom(url.searchParams.get('room') || '', url.searchParams.get('session') || '')
              if (!room) return sendJson(res, 200, { ok: true, room: null, rooms: roomsBrief(), messages: [] })
              return sendJson(res, 200, {
                ok: true,
                room: { id: room.id, name: room.name, status: room.status },
                rooms: roomsBrief(),
                seats: Object.entries(room.seats || {}).map(([name, ids]) => ({ name, ids })),
                messages: rooms.readMessages(root(), room.id, 100),
              })
            }
            if (req.method === 'POST') {
              const body = await readBody(req)
              // 界面上的几个动作：建、改名、解散。跟工具里的是同一套。
              const op = String(body.op || '')
              if (op) {
                if (op === 'create') {
                  const want = String(body.name || '').trim()
                  const clash = rooms.nameTaken(rooms.loadIndex(root()), want)
                  if (clash) return sendJson(res, 400, { ok: false, error: `已经有叫《${clash.name}》的房间了` })
                  const made = rooms.createRoom(root(), want, { members: [humanName()] })
                  return sendJson(res, 200, { ok: true, room: { id: made.id, name: made.name }, rooms: roomsBrief() })
                }
                const target = resolveRoom(body.room || '', '')
                if (!target) return sendJson(res, 400, { ok: false, error: '不知道是哪间房' })
                if (op === 'rename') {
                  const clash = rooms.nameTaken(rooms.loadIndex(root()), String(body.name || '').trim(), target.id)
                  if (clash) return sendJson(res, 400, { ok: false, error: `已经有叫《${clash.name}》的房间了` })
                  const r = rooms.renameRoom(root(), target, body.name)
                  if (!r.ok) return sendJson(res, 400, { ok: false, error: r.text })
                  rooms.appendMessage(root(), target.id, {
                    id: 'm-' + Date.now().toString(36),
                    at: new Date().toISOString(),
                    from: '（房间）',
                    text: `这间房改名叫《${r.next}》了（原来叫《${r.old}》）。`,
                  })
                  return sendJson(res, 200, { ok: true, rooms: roomsBrief() })
                }
                if (op === 'dispose') {
                  const told = await notifyDispose(target)
                  const r = rooms.disposeRoom(root(), target)
                  return sendJson(res, r.ok ? 200 : 400, {
                    ok: r.ok,
                    error: r.ok ? undefined : r.text,
                    told,
                    rooms: roomsBrief(),
                  })
                }
                return sendJson(res, 400, { ok: false, error: '不认识的操作' })
              }
              const room = resolveRoom(body.room || '', '')
              if (!room) return sendJson(res, 400, { ok: false, error: '不知道是哪间房' })
              const from = String(body.from || humanName())
              const r = await sayInRoom(room, from, body.text, {
                expects: typeof body.expects === 'boolean' ? body.expects : undefined,
                wake: body.wake,
              })
              if (!r.ok) return sendJson(res, 400, r)
              return sendJson(res, 200, { ok: true, message: r.rec, woke: r.woke, capped: !!r.capped })
            }
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          } catch (e) {
            diag('房间接口出错：' + (e && e.message))
            return sendJson(res, 500, { ok: false, error: String(e && e.message) })
          }
        },
      })
    )
    diag('房间接口挂上了：/dafeiyu-chatroom/room')
  }

  try {
    keep(ctx.inject(['webServer'], (webCtx) => mountApi(webCtx)))
  } catch (e) {
    diag('挂房间接口失败：' + (e && e.message))
  }

  const dispose = () => {
    for (const timers of pendingWakes.values()) {
      for (const t of timers.values()) clearTimeout(t)
    }
    pendingWakes.clear()
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* 拆的时候出错不算错 */
      }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
}
