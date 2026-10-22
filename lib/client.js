/**
 * dsh-vision-click :: browser half — the "allow screen control" switch in the
 * composer, right next to the model selector.
 *
 * Deliberately written in the same format the Web shell's module loader expects
 * (window.__ModuleLoader__.load + a factory), so it is a real, servable client
 * bundle: the host scans `dsh.client` in package.json and serves this file.
 *
 * The switch does not keep its own truth: every read and every toggle goes
 * through the host command `/vision`, which answers with a machine token
 * (SCREEN_CONTROL=on/off). That way the checkbox can never claim "allowed"
 * while the host would refuse, and running `/vision off` by hand is reflected
 * here too.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vision-click',
  factory: (require) => {
    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    const TOKEN_ON = /SCREEN_CONTROL=on/;
    const TOKEN_OFF = /SCREEN_CONTROL=off/;

    /** Pull the answer text out of a command execution, whatever shape it is. */
    function answerText(result) {
      const value = result && result.value;
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (typeof value.text === 'string') return value.text;
      if (value.result && typeof value.result.text === 'string') return value.result.text;
      return JSON.stringify(value);
    }

    function useConsent(sessionId, sessions) {
      const [status, setStatus] = React.useState('checking'); // checking | on | off | unknown
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const run = React.useCallback(
        async (line) => {
          const live = sessions && sessions.binding ? sessions.binding(sessionId)?.session : undefined;
          if (!live || typeof live.command !== 'function') throw new Error('会话尚未准备好');
          const result = await live.command(line);
          if (!result || result.ok !== true) {
            const detail = result && result.error ? `${result.error.code}: ${result.error.message}` : '命令执行失败';
            throw new Error(detail);
          }
          return answerText(result);
        },
        [sessionId, sessions],
      );

      const refresh = React.useCallback(async () => {
        try {
          const text = await run('/vision status');
          setStatus(TOKEN_ON.test(text) ? 'on' : TOKEN_OFF.test(text) ? 'off' : 'unknown');
          setError('');
        } catch (cause) {
          setStatus('unknown');
          setError(String((cause && cause.message) || cause));
        }
      }, [run]);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          const live = sessions && sessions.binding ? sessions.binding(sessionId)?.session : undefined;
          if (!live || typeof live.command !== 'function') {
            if (alive) setStatus('unknown');
            return;
          }
          try {
            const text = await run('/vision status');
            if (!alive) return;
            setStatus(TOKEN_ON.test(text) ? 'on' : TOKEN_OFF.test(text) ? 'off' : 'unknown');
          } catch (cause) {
            if (alive) {
              setStatus('unknown');
              setError(String((cause && cause.message) || cause));
            }
          }
        })();
        return () => {
          alive = false;
        };
      }, [run, sessionId, sessions]);

      const toggle = React.useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          await run(status === 'on' ? '/vision off' : '/vision arm');
          await refresh();
        } catch (cause) {
          setError(String((cause && cause.message) || cause));
          await refresh().catch(() => {});
        } finally {
          setBusy(false);
        }
      }, [busy, refresh, run, status]);

      return { status, busy, error, toggle, refresh };
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
      const unknown = status === 'unknown';
      const title = unknown
        ? `无法读取授权状态${error ? `：${error}` : ''}`
        : on
          ? '屏幕控制已授权：点击收回（等同 /vision off）'
          : '屏幕控制未授权：点击允许截屏与鼠标操作（等同 /vision arm）';

      const label = unknown ? '屏幕控制 ?' : on ? '屏幕控制：开' : '屏幕控制：关';

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
            jsx('span', { style: dotStyle(on ? 'rgb(46,160,67)' : unknown ? 'rgb(191,148,0)' : 'rgba(128,128,128,0.7)') }),
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
