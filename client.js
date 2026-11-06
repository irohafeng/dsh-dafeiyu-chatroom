// 房间：侧栏一个入口，点开是一整页。
//
// 页面上做四件事：在几间房之间换、建新的一间、改名、解散；中间是话，底下是先生打字。
// 数据全走宿主那条本机接口 /dafeiyu-chatroom/room。
window.__ModuleLoader__.load({
  id: 'dsh-dafeiyu-chatroom',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 用主题自己的令牌，别自己写死颜色：写死的那几个在某套主题下就是「看不见」。
    const LINE = 'var(--dsw-alias-border-l1)'
    const OVERLAY = 'var(--dsw-alias-bg-overlay)'
    const LAYER = 'var(--dsw-alias-bg-layer-1)'
    const TEXT = 'var(--dsw-alias-label-primary)'
    const TEXT2 = 'var(--dsw-alias-label-secondary)'
    const ACCENT = 'var(--dsw-alias-brand-primary)'
    const DANGER = 'var(--dsw-alias-state-error-primary)'
    const SEEN_KEY = (id) => 'dafeiyu-chatroom.seen.' + id
    const NOTE = '（房间）'

    const styles = {
      page: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        gap: 10,
        padding: '12px 18px 16px',
        boxSizing: 'border-box',
        fontSize: 14,
        lineHeight: 1.6,
      },
      bar: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 },
      roomBtn: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 8,
        border: `1px solid ${LINE}`,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontWeight: 600,
      },
      menu: {
        position: 'absolute',
        top: 34,
        left: 0,
        zIndex: 30,
        minWidth: 190,
        padding: 6,
        borderRadius: 10,
        border: `1px solid ${LINE}`,
        background: OVERLAY,
        color: TEXT,
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      },
      item: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 10,
        padding: '6px 8px',
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      },
      dot: { width: 7, height: 7, borderRadius: 4, background: ACCENT, display: 'inline-block' },
      icon: {
        width: 30,
        height: 30,
        borderRadius: 8,
        border: `1px solid ${LINE}`,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        lineHeight: 1,
      },
      list: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 },
      row: { display: 'flex', gap: 10, alignItems: 'baseline' },
      who: { fontWeight: 600, opacity: 0.7, minWidth: 58, flexShrink: 0, fontSize: 13 },
      text: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      note: { opacity: 0.5, fontSize: 13, fontStyle: 'italic' },
      hang: { opacity: 0.55, fontSize: 12, marginLeft: 6 },
      composer: { display: 'flex', gap: 8, borderTop: `1px solid ${LINE}`, paddingTop: 10 },
      input: {
        flex: 1,
        padding: '9px 11px',
        borderRadius: 10,
        border: `1px solid ${LINE}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        resize: 'none',
        minHeight: 40,
      },
      btn: {
        padding: '0 18px',
        borderRadius: 10,
        border: `1px solid ${LINE}`,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      wants: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.75 },
      empty: { opacity: 0.5, textAlign: 'center', marginTop: 40 },
      meta: { opacity: 0.6, fontSize: 12, marginLeft: 'auto' },
      dialog: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 10,
        border: `1px solid ${LINE}`,
        background: LAYER,
        color: TEXT,
      },
      dialogRow: { display: 'flex', gap: 8, alignItems: 'center' },
      dialogText: { fontSize: 13, opacity: 0.85 },
      danger: { color: DANGER },
    }

    function pendingIds(list) {
      const out = new Set()
      for (let i = 0; i < list.length; i++) {
        const r = list[i]
        if (!r.expects) continue
        const answered = list.slice(i + 1).some((l) => l.from !== r.from && l.from !== NOTE)
        if (!answered) out.add(r.id)
      }
      return out
    }

    const readSeen = (id) => {
      try {
        return Number(localStorage.getItem(SEEN_KEY(id)) || 0)
      } catch {
        return 0
      }
    }
    const writeSeen = (id, n) => {
      try {
        localStorage.setItem(SEEN_KEY(id), String(n))
      } catch {
        /* 存不了就算了 */
      }
    }

    function Room() {
      const [rooms, setRooms] = React.useState([])
      const [current, setCurrent] = React.useState('')
      const [msgs, setMsgs] = React.useState([])
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [wants, setWants] = React.useState(true)
      const [note, setNote] = React.useState('')
      const [open, setOpen] = React.useState(false)
      // 不用 window.prompt：Electron 的窗口里没实现它，点了就是「没反应」。
      // 改用自己的小弹层，顺便能把要问的问清楚。
      const [dialog, setDialog] = React.useState(null) // { kind, value }
      const listRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          const q = current ? `?room=${encodeURIComponent(current)}` : ''
          const r = await fetch('/dafeiyu-chatroom/room' + q, { headers: { accept: 'application/json' } })
          const j = await r.json()
          if (!j || !j.ok) return
          if (Array.isArray(j.rooms)) setRooms(j.rooms)
          if (j.room && j.room.id !== current) setCurrent(j.room.id)
          if (Array.isArray(j.messages)) setMsgs(j.messages)
        } catch {
          /* 宿主还没起来就先空着 */
        }
      }, [current])

      React.useEffect(() => {
        load()
        const t = setInterval(load, 2000)
        return () => clearInterval(t)
      }, [load])

      React.useEffect(() => {
        const el = listRef.current
        if (el) el.scrollTop = el.scrollHeight
        if (current) writeSeen(current, msgs.length)
      }, [msgs.length, current])

      const post = async (body) => {
        const r = await fetch('/dafeiyu-chatroom/room', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = await r.json().catch(() => ({}))
        if (Array.isArray(j.rooms)) setRooms(j.rooms)
        return j
      }

      const send = async () => {
        const text = draft.trim()
        if (!text || busy) return
        setBusy(true)
        try {
          const j = await post({ room: current, from: '先生', text, expects: wants })
          setDraft('')
          const woke = (j && j.woke) || []
          const okNames = woke.filter((w) => w.ok).map((w) => w.name)
          setNote(okNames.length ? '叫了 ' + okNames.join('、') : j?.error || '')
          await load()
        } catch {
          setNote('没发出去')
        } finally {
          setBusy(false)
        }
      }

      const createRoom = () => {
        setOpen(false)
        setDialog({ kind: 'create', value: '房间' })
      }

      const renameRoom = () => {
        const now = rooms.find((r) => r.id === current)
        setOpen(false)
        setDialog({ kind: 'rename', value: now ? now.name : '' })
      }

      const disposeRoom = () => {
        setOpen(false)
        setDialog({ kind: 'dispose', value: '' })
      }

      const runDialog = async () => {
        const d = dialog
        if (!d) return
        setDialog(null)
        try {
          if (d.kind === 'create') {
            const j = await post({ op: 'create', name: String(d.value || '').trim() || '房间' })
            if (j && j.room) setCurrent(j.room.id)
          } else if (d.kind === 'rename') {
            const name = String(d.value || '').trim()
            if (name) await post({ op: 'rename', room: current, name })
          } else if (d.kind === 'dispose') {
            await post({ op: 'dispose', room: current })
            setCurrent('')
          }
          await load()
        } catch {
          setNote('没成')
        }
      }

      const currentRoom = rooms.find((r) => r.id === current) || null
      const hang = pendingIds(msgs)
      const unread = (r) => Math.max(0, (r.count || 0) - readSeen(r.id))

      return h('div', { style: styles.page }, [
        h('div', { key: 'bar', style: styles.bar }, [
          h('div', { key: 'sw', style: { position: 'relative' } }, [
            h(
              'button',
              { key: 'b', style: styles.roomBtn, onClick: () => setOpen((v) => !v) },
              (currentRoom ? '《' + currentRoom.name + '》' : '还没有房间') + ' ▾'
            ),
            open
              ? h('div', { key: 'm', style: styles.menu }, [
                  ...(rooms.length
                    ? rooms.map((r) =>
                        h(
                          'button',
                          {
                            key: r.id,
                            style: styles.item,
                            onClick: () => {
                              setCurrent(r.id)
                              setOpen(false)
                            },
                          },
                          [
                            h('span', { key: 'n' }, '《' + r.name + '》' + (r.id === current ? ' ✓' : '')),
                            unread(r)
                              ? h('span', { key: 'd', style: styles.dot, title: `${unread(r)} 条新的` })
                              : null,
                          ]
                        )
                      )
                    : [h('div', { key: 'e', style: { ...styles.item, opacity: 0.5 } }, '一间都没有')]),
                  h('button', { key: 'c', style: styles.item, onClick: createRoom }, '＋ 新建一间'),
                ])
              : null,
          ]),
          h('button', { key: 'plus', style: styles.icon, title: '新建一间', onClick: createRoom }, '+'),
          currentRoom ? h('button', { key: 'rn', style: styles.icon, title: '改名', onClick: renameRoom }, '✎') : null,
          currentRoom ? h('button', { key: 'del', style: styles.icon, title: '解散', onClick: disposeRoom }, '✕') : null,
          h(
            'span',
            { key: 'meta', style: styles.meta },
            note || (currentRoom ? `${msgs.length} 条${hang.size ? ` · ${hang.size} 条没人接` : ''}` : '')
          ),
        ]),
        dialog
          ? h('div', { key: 'dlg', style: styles.dialog }, [
              h(
                'div',
                { key: 't', style: styles.dialogText },
                dialog.kind === 'create'
                  ? '新房间叫什么？'
                  : dialog.kind === 'rename'
                    ? `把《${currentRoom ? currentRoom.name : ''}》改成什么名字？`
                    : `解散《${currentRoom ? currentRoom.name : ''}》？屋里的话会真的删掉，只在总表里留一块碑（名字和散的时间）。这一下不能撤销。`
              ),
              dialog.kind === 'dispose'
                ? null
                : h('div', { key: 'r', style: styles.dialogRow }, [
                    h('input', {
                      key: 'i',
                      style: styles.input,
                      value: dialog.value,
                      autoFocus: true,
                      onChange: (e) => setDialog({ ...dialog, value: e.target.value }),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') runDialog()
                        if (e.key === 'Escape') setDialog(null)
                      },
                    }),
                  ]),
              h('div', { key: 'a', style: styles.dialogRow }, [
                h(
                  'button',
                  { key: 'ok', style: { ...styles.btn, ...(dialog.kind === 'dispose' ? styles.danger : null) }, onClick: runDialog },
                  dialog.kind === 'dispose' ? '解散' : '确定'
                ),
                h('button', { key: 'no', style: styles.btn, onClick: () => setDialog(null) }, '取消'),
              ]),
            ])
          : null,
        h(
          'div',
          { key: 'list', ref: listRef, style: styles.list },
          msgs.length
            ? msgs.map((m) =>
                h('div', { key: m.id, style: styles.row }, [
                  h('span', { key: 'w', style: styles.who }, m.from),
                  h('span', { key: 't', style: m.from === NOTE ? styles.note : styles.text }, [
                    m.text,
                    hang.has(m.id) ? h('span', { key: 'h', style: styles.hang }, '（还挂着，没人接）') : null,
                  ]),
                ])
              )
            : [
                h(
                  'div',
                  { key: 'e', style: styles.empty },
                  currentRoom ? '这间屋里还没人说话' : '还没有房间，点上面的 + 建一间'
                ),
              ]
        ),
        h('div', { key: 'c', style: styles.composer }, [
          h('textarea', {
            key: 'i',
            style: styles.input,
            rows: 1,
            value: draft,
            placeholder: currentRoom ? '在这儿说一句…（Enter 说，Shift+Enter 换行）' : '先建一间房',
            disabled: !currentRoom,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            },
          }),
          h(
            'div',
            { key: 'opt', style: { display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center' } },
            [
              h('label', { key: 'l', style: styles.wants }, [
                h('input', { key: 'b', type: 'checkbox', checked: wants, onChange: (e) => setWants(e.target.checked) }),
                '叫他们来看',
              ]),
              h('button', { key: 's', style: styles.btn, disabled: busy || !currentRoom, onClick: send }, busy ? '…' : '说'),
            ]
          ),
        ]),
      ])
    }

    /** 侧栏那个小图标：一句话泡泡，里面三个点。 */
    function RoomIcon(props) {
      const size = (props && props.size) || 20
      const active = !!(props && props.active)
      const dot = active ? 'rgba(0,0,0,0.55)' : 'currentColor'
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4.4 3.3A.6.6 0 0 1 3.6 21V7a2 2 0 0 1 .4-2z',
          fill: active ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8.5, cy: 11.5, r: 1.3, fill: dot }),
        h('circle', { cx: 12, cy: 11.5, r: 1.3, fill: dot }),
        h('circle', { cx: 15.5, cy: 11.5, r: 1.3, fill: dot })
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'room', order: 20, label: '房间' }, RoomIcon)
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'room' }, Room))
      },
    }
  },
})
