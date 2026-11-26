
import '../lib/setup.js';
import '../lib/container.js';
import { render } from 'ink';
import App from './App.js';
import { stopBot } from '../lib/bot.js';
import { InkPictureProvider } from 'ink-picture';

process.env.CAPYGG_TUI = '1';

const TUI_SIZE = {
    columns: 150,
    rows: 45
};

/**
 * Ink 8 adds incremental line rendering and synchronized terminal updates.
 * Keep this proxy for Windows launchers that expose stdin as a TTY but omit
 * stdout.isTTY; all writes still go to the original stdout stream.
 */
function getInkStdout(): NodeJS.WriteStream {
    if (process.stdout.isTTY) return process.stdout;

    if (!process.stdin.isTTY) {
        throw new Error(
            'CapyGG TUI requires an interactive terminal. Run it directly in Windows Terminal / PowerShell, not through a pipe or redirected output.'
        );
    }

    return new Proxy(process.stdout, {
        get(target, property) {
            if (property === 'isTTY') return true;

            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
        }
    }) as NodeJS.WriteStream;
}

const stdout = getInkStdout();

/**
 * Windows Terminal supports CSI 8;rows;columns t.
 * We only attempt resizing when running inside Windows Terminal
 * and the original terminal dimensions are available.
 */
const isWindowsTerminal =
    process.platform === 'win32' && Boolean(process.env.WT_SESSION);

const originalTerminalSize =
    isWindowsTerminal &&
    typeof stdout.columns === 'number' &&
    typeof stdout.rows === 'number'
        ? {
              columns: stdout.columns,
              rows: stdout.rows
          }
        : null;

let terminalSizeChanged = false;
let terminalSizeRestored = false;

function resizeTerminal(columns: number, rows: number): void {
    stdout.write(`\x1b[8;${rows};${columns}t`);
}

function restoreTerminalSize(): void {
    if (
        !terminalSizeChanged ||
        terminalSizeRestored ||
        !originalTerminalSize
    ) {
        return;
    }

    terminalSizeRestored = true;

    resizeTerminal(
        originalTerminalSize.columns,
        originalTerminalSize.rows
    );
}

// Resize before Ink initializes its layout.
if (
    originalTerminalSize &&
    (originalTerminalSize.columns !== TUI_SIZE.columns ||
        originalTerminalSize.rows !== TUI_SIZE.rows)
) {
    terminalSizeChanged = true;
    resizeTerminal(TUI_SIZE.columns, TUI_SIZE.rows);
}

const instance = render(
    <InkPictureProvider config={{ cacheSize: 10 }}>
        <App />
    </InkPictureProvider>,
    {
        stdout,
        stdin: process.stdin,
        stderr: process.stderr,
        exitOnCtrlC: false,
        debug: false,
        patchConsole: false,
        interactive: true,
        alternateScreen: true,
        incrementalRendering: true,
        maxFps: 20
    }
);

let shuttingDown = false;

async function shutdown(): Promise<void> {
    if (shuttingDown) return;

    shuttingDown = true;

    try {
        await stopBot();
    } finally {
        instance.unmount();
        restoreTerminalSize();
    }
}

// Q / normal Ink exit: restore the original terminal dimensions.
void instance.waitUntilExit().then(() => {
    instance.unmount();
    restoreTerminalSize();
});

// Fallback for normal process termination.
process.once('exit', restoreTerminalSize);

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
