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
import { homedir, tmpdir } from 'node:os'
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
  human: '先生',
  autoWakeTurns: 10,
}

const FIELDS = {
  action: {
    type: 'string',
    required: true,
    enum: ['say', 'read', 'info', 'list', 'create', 'rename', 'dispose', 'join', 'wake'],
    description:
      'say=说一句；read=看没看过的话；info=这间房的状况；list=列出所有房间；create=建一间；rename=改名；dispose=解散；join=让这间会话入座；wake=叫醒某人。',
  },
  room: { type: 'string', description: 'action 作用在哪间（名字或 id）。不给就用这间会话默认的那间。' },
  text: { type: 'string', description: 'say 要说的话；rename 的新名字。' },
  name: { type: 'string', description: 'create 的房间名；join 时我在屋里叫什么。' },
  session: { type: 'string', description: 'wake 时用：叫醒哪个会话。' },
  expects: {
    type: 'boolean',
    description: 'say 时用：这句话是不是抛出去等人接。是才叫醒别人；默认不是。',
  },
  replyTo: { type: 'string', description: 'say 时可选：回的是哪一条。不是硬条件，有人开口就算接上。' },
  to: { type: 'string', description: 'say 时可选：收件人。填了就定向叫他一次，不必把话硬说成问句。' },
  wake: { type: 'boolean', description: 'say 时可选：false 表示只记下，一个人都不叫。' },
  n: { type: 'number', description: 'read 时看几条，默认 20。' },
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
  const isHuman = (who) => String(who || '') === String(conf().human || '先生')

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
    const text =
      `【房间】《${note.room.name}》里${note.lastFrom === person ? '有人接着说话' : note.lastFrom + ' 说了话'}，你可以过来看一眼——不是点名要你回答。\n` +
      `你上次看过之后，屋里多了 ${note.count} 条。想看就用 room 工具、action 填 read。\n\n` +
      '看完你说也行，不说也行；不想说就什么也不用做，没人会等着你回。'
    try {
      // 叫之前先看他忙不忙：忙的话这条会排队，说话的人得知道，别以为没送到
      let busy = false
      try {
        const a = ctx.get && ctx.get('agents') ? ctx.get('agents').get(id) : undefined
        busy = !!(a && a.status && a.status !== 'idle')
      } catch {
        busy = false
      }
      const r = await ctx.sessionController.prompt(
        {
          requestId: 'room-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          sessionId: id,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal
      )
      diag(`wake ${id} -> ${JSON.stringify(r)} busy=${busy}`)
      return {
        ok: true,
        busy,
        message: `叫了 ${person}（${busy ? '在忙，排着' : '空闲'}），它还有 ${note.count} 条没看。`,
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
    return { room: r, count: fresh.length, lastFrom: fresh.length ? fresh[fresh.length - 1].from : '' }
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
      if (!r.expects) continue
      const answered = records.slice(i + 1).some((l) => l.from !== r.from && l.from !== NOTE)
      if (!answered) out.push(r)
    }
    return out
  }

  const renderMsg = (records) => {
    if (!records.length) return '（这间屋里还没有人说话）'
    return records
      .map((r) => {
        const hang = r.expects && !records.some((l) => l.at > r.at && l.from !== r.from && l.from !== NOTE) ? '  ← 还没人接' : ''
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
    if (opts.replyTo) rec.replyTo = String(opts.replyTo)
    rooms.appendMessage(root(), room.id, rec)

    const budget = Number(conf().autoWakeTurns ?? 10)
    const st = readState()
    let turns = Number(st.agentTurns || 0)
    turns = human ? 0 : turns + 1
    writeState({ agentTurns: turns, lastFrom: String(from), lastAt: rec.at })
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

    // 有人接了还挂着的话：把那条的作者叫回来。不靠 replyTo，靠屋里的事实。
    if (before.length) {
      let hangs = before.filter((r) => pendingBefore.has(r.id) && r.from && r.from !== from && !isHuman(r.from))
      if (opts.replyTo) {
        const only = hangs.filter((r) => r.id === String(opts.replyTo))
        if (only.length) hangs = only
      }
      for (const one of hangs) if (!targets.includes(one.from)) targets.push(one.from)
    }

    // 填了收件人：定向叫他一次。诊断、交接这类话本质是「办给她」，长得却像陈述，
    // 硬要写成问句才叫得动，就又回到「靠记得」——所以给一个明说的口子。
    if (opts.to) {
      const want = String(opts.to).trim()
      if (want && want !== from) targets = [...new Set([want, ...targets])]
    }

    const woke = []
    for (const person of targets) {
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
        // 建房子的人不进座：建是建，请是请。先生建，然后单独请谁进来。
        const want = String(args?.name || '').trim()
        const clash = rooms.nameTaken(index, want)
        if (clash) return { ok: false, message: `已经有叫《${clash.name}》的房间了（${clash.id}）。换个名字，或者把它解散。` }
        const made = rooms.createRoom(root(), want, { members: [conf().human || '先生'] })
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
        rooms.claimName(root(), room, sessionId, person)
        setDefaultRoom(sessionId, room.id)
        rememberRoom(recallKey(sessionId), room.id)
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
          replyTo: args?.replyTo,
          to: args?.to,
          wake: args?.wake === false ? false : undefined,
          selfSession: sessionId,
        })
        if (!r.ok) return r
        const called = r.woke.filter((w) => w.ok).map((w) => (w.busy ? `${w.name}（在忙，排着）` : `${w.name}（空闲）`))
        const tail = r.capped
          ? '；连着转了几轮，先不叫人了'
          : called.length
            ? `，叫了 ${called.join('、')}`
            : r.rec.expects
              ? '，挂着等人接'
              : '，没叫人'
        return { ok: true, message: `说了（${r.rec.id}）@《${room.name}》${tail}。` }
      }

      case 'read': {
        const miss = needRoom()
        if (miss) return miss
        const person = rooms.personOf(room, sessionId)
        const all = rooms.readMessages(root(), room.id, 0)
        const cap = Number(args?.n) > 0 ? Math.min(200, Number(args.n)) : 20
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

      default:
        return { ok: false, message: `不认识的 action：${action}` }
    }
  }

  const defineTool = loadDefineTool()
  if (typeof defineTool === 'function' && typeof ctx.tools?.register === 'function') {
    try {
      const tool = defineTool({
        name: 'room',
        description: '房间：一间屋里几个人说话。我、另一个人、还有先生。用它说话、看别人说了什么。',
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
                  const made = rooms.createRoom(root(), want, { members: [conf().human || '先生'] })
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
              const from = String(body.from || conf().human || '先生')
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
