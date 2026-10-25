/**
 * dsh-vision-click :: browser half — the "allow screen control" switch in the
 * composer, right next to the model selector.
 *
 * Deliberately written in the format the Web shell's module loader expects
 * (window.__ModuleLoader__.load + a factory), so it is a real, servable client
 * bundle: the host scans `dsh.client` in package.json and serves this file.
 *
 * The switch does not keep its own truth. DSH 0.2 settled `session.command()`
 * to admission only (`{ ok, value: { matched } }`): the handler's text is no
 * longer returned, it is logged as the durable `command/done` event that the
 * transcript renders. This bundle therefore reads the SCREEN_CONTROL token from
 * the session's event window and subscribes to it, so every read and every
 * toggle still goes through the host and the switch can never claim "allowed"
 * while the host would refuse.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vision-click',
  factory: (require) => {
    // dsh-client-modules calls the factory with only `require` and uses the
    // returned exports; the shipped ui-* bundles declare module/exports here
    // for the same reason. Without this the bundle throws "exports is not
    // defined" and fails the whole Web boot (not just this plugin).
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    const TOKEN = /SCREEN_CONTROL=(on|off)/;

    /** Page-lifetime knowledge of the host's consent, shared by every session. */
    let known = null;
    /** Event time of the token behind `known`, so a newer command in any session wins. */
    let knownAt = 0;
    /** The single host-truth probe this page performs, when history made one necessary. */
    let probe;
    /** A user command supersedes the probe: the host's own answer arrives next. */
    let userActed = false;

    /** Newest SCREEN_CONTROL token in the loaded event window, or null. */
    function consentIn(entries) {
      if (!Array.isArray(entries)) return null;
      const stop = Math.max(0, entries.length - 500);
      for (let index = entries.length - 1; index >= stop; index -= 1) {
        const event = entries[index] && entries[index].event;
        if (!event || event.type !== 'command/done') continue;
        const text = event.data && event.data.text;
        if (typeof text !== 'string') continue;
        const match = TOKEN.exec(text);
        if (match) return { value: match[1], at: typeof event.time === 'number' ? event.time : 0 };
      }
      return null;
    }

    /**
     * Ask the host once per page load. A logged token survives a host restart
     * while the host's consent does not, so the newest token alone can be
     * stale; the probe's own `command/done` is the authoritative answer.
     */
    function probeConsent(live) {
      if (probe !== undefined || userActed) return;
      if (!live || typeof live.command !== 'function') return;
      probe = (async () => {
        try {
          await live.command('/vision status');
        } catch {
          /* keep showing the token we have; the switch still toggles */
        }
      })();
    }

    function useConsent(sessionId, sessions) {
      const [status, setStatus] = React.useState(known ?? 'unknown');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const binding = (() => {
        if (!sessions || typeof sessions.binding !== 'function' || sessionId === undefined) return undefined;
        try {
          return sessions.binding(sessionId);
        } catch {
          return undefined;
        }
      })();
      const live = binding && binding.session;
      const source = binding && binding.eventSource;

      // Follow the durable command/done events: they carry the handler text on
      // every host version that has no return-value channel.
      React.useEffect(() => {
        if (!source || typeof source.subscribe !== 'function') return undefined;
        let alive = true;
        let first = true;
        const read = () => {
          if (!alive) return;
          let snapshot;
          try {
            snapshot = source.getSnapshot();
          } catch {
            return;
          }
          const token = consentIn(snapshot.entries);
          const isLive = !first && snapshot.change !== undefined && snapshot.change.kind === 'append';
          const hadKnown = known !== null;
          first = false;
          // The newest event time wins across sessions: a manual /vision in
          // another session is newer than what this page learned before it.
          if (token !== null && (!hadKnown || token.at > knownAt)) {
            known = token.value;
            knownAt = token.at;
            setStatus(token.value);
          }
          if (isLive) return;
          // A history page with no page knowledge yet: one host-truth probe
          // guards against a token that predates a host restart.
          if (!hadKnown && token !== null) probeConsent(live);
          setStatus(known ?? 'unknown');
        };
        const unsubscribe = source.subscribe(read);
        read();
        return () => {
          alive = false;
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [source, live]);

      const toggle = React.useCallback(async () => {
        if (busy) return;
        if (!live || typeof live.command !== 'function') {
          setError('会话尚未准备好');
          return;
        }
        userActed = true;
        if (probe === undefined) probe = Promise.resolve();
        setBusy(true);
        setError('');
        try {
          const result = await live.command(status === 'on' ? '/vision off' : '/vision arm');
          if (!result || result.ok !== true) {
            const detail = result && result.error ? `${result.error.code}: ${result.error.message}` : '命令执行失败';
            throw new Error(detail);
          }
          if (result.value && result.value.matched === false) throw new Error('宿主没有识别 /vision 命令');
        } catch (cause) {
          setError(String((cause && cause.message) || cause));
        } finally {
          setBusy(false);
        }
      }, [busy, live, status]);

      return { status, busy, error, toggle };
    }

    const baseStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '28px',
      padding: '0 10px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-neutral, rgba(128,128,128,0.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '1',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };

    const dotStyle = (color) => ({
      width: '8px',
      height: '8px',
      borderRadius: '999px',
      background: color,
      flex: 'none',
    });

    function VisionConsent(props) {
      const sessionId = props.sessionId;
      const { status, busy, error, toggle } = useConsent(sessionId, props.sessions);
      if (sessionId === undefined) return null;

      const on = status === 'on';
      const off = status === 'off';
      const title =
        (on
          ? '屏幕控制已授权：点击收回（等同 /vision off）'
          : off
            ? '屏幕控制未授权：点击允许截屏与鼠标操作（等同 /vision arm）'
            : '屏幕控制状态未知：点击授权（等同 /vision arm）') +
        (error ? `\n最近一次操作失败：${error}` : '');

      const label = on ? '屏幕控制：开' : off ? '屏幕控制：关' : '屏幕控制';

      return jsx('button', {
        type: 'button',
        title,
        'aria-pressed': on,
        'aria-label': label,
        disabled: busy,
        onClick: toggle,
        style: {
          ...baseStyle,
          opacity: busy ? 0.6 : 1,
          borderColor: on
            ? 'var(--dsw-alias-state-success-border, rgba(46,160,67,0.6))'
            : 'var(--dsw-alias-border-neutral, rgba(128,128,128,0.35))',
        },
        children: jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
          children: [
            jsx('span', {
              style: dotStyle(on ? 'rgb(46,160,67)' : off ? 'rgba(128,128,128,0.7)' : 'rgb(191,148,0)'),
            }),
            jsx('span', { children: busy ? '处理中…' : label }),
          ],
        }),
      });
    }

    const inject = ['slots', 'sessions'];

    function apply(ctx) {
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'vision-consent',
            order: 10,
            inject: (sessionId) => ({ sessions: ctx.sessions, sessionId }),
          },
          VisionConsent,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
