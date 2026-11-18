/** Retain an ordinary Session through the real right sidebar Tab lifecycle. */
window.__ModuleLoader__.load({
  id: '@fixture/retained-sidebar',
  factory(require) {
    const { createElement, useSyncExternalStore } = require('react')
    const kind = 'fixture-retained-sidebar'
    const title = () => 'History retention fixture'
    return {
      inject: ['sessions', 'sidebarRightTabs', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: kind, kind, title, keepMounted: true,
          guide: [{ id: 'open', order: 100, title }],
        }))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: kind,
          inject: sessionId => {
            const binding = ctx.sessions.binding(sessionId)
            if (binding === undefined) throw new Error('The retained sidebar Session has no active binding')
            const events = binding.eventSource
            return { useFirstHistorySeq: () => useSyncExternalStore(
              listener => events.subscribe(listener),
              () => events.getSnapshot().entries[0]?.event.seq,
            ) }
          },
        }, ({ useFirstHistorySeq, useSession }) => {
          const firstSeq = useFirstHistorySeq()
          const loadingOlder = useSession(snapshot => snapshot.loadingOlder)
          return createElement('p', {
            'data-fixture-retained-sidebar': '',
            'data-fixture-history-first-seq': firstSeq,
            'data-fixture-history-loading-older': String(loadingOlder),
          }, title())
        }))
      },
    }
  },
})
