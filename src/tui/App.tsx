import { readFileSync } from 'node:fs';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { getBotClient, startBot, stopBot } from '../lib/bot.js';
import { getCronJobs, runCronJob, type CronJobSnapshot } from '../lib/scheduler.js';
import { telemetry, type LogEntry, type LogLevel } from '../lib/telemetry.js';
import { riotRequestQueue } from '../lib/riot/request-queue.js';
import { PixelAvatar } from './PixelAvatar.js';
import {
	fetchGuildMemberStats,
	formatDuration,
	formatTime,
	getRuntimeSettings,
	loadAccounts,
	loadDatabaseStats,
	loadGuilds,
	loadOverview,
	getMetricsSnapshot,
	type AccountRow,
	type GuildRow,
	type OverviewData
} from './data.js';
import stringWidth from 'string-width';
import {
	EASTER_EGGS,
	IDLE_MESSAGES,
	WORKING_MESSAGES,
	pickMessage,
	startupQuote
} from './messages.js';


const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };

const BOT_VERSION = packageJson.version ?? 'dev';

const MemoizedPixelAvatar = memo(PixelAvatar);

const C = {
	bg: '#10151D',
	border: '#334155',
	text: '#E6EDF6',
	muted: '#91A1B5',
	cyan: '#65D6E8',
	green: '#73D9A0',
	yellow: '#E9BC70',
	red: '#F07878',
	purple: '#B69AF5',
	blue: '#82B7F4'
};

const NAV = [
	{ id: 'overview', label: 'Overview', key: '1' },
	{ id: 'logs', label: 'Logs', key: '2' },
	{ id: 'users', label: 'Users', key: '3' },
	{ id: 'accounts', label: 'LoL Accounts', key: '4' },
	{ id: 'guilds', label: 'Guilds', key: '5' },
	{ id: 'queue', label: 'Riot Queue', key: '6' },
	{ id: 'crons', label: 'Schedulers', key: '7' },
	{ id: 'metrics', label: 'API Metrics', key: '8' },
	{ id: 'database', label: 'Database', key: '9' },
	{ id: 'settings', label: 'Settings', key: '0' }
] as const;

type Page = (typeof NAV)[number]['id'];
type LogFilter = 'all' | 'info' | 'warn' | 'error' | 'debug';

const ascii = [
	' ███   ███  ████  █   █  ███  ███',
	'█   █ █   █ █   █  █ █  █    █   ',
	'█     █████ ████    █   █ ██ █ ██',
	'█  ██ █   █ █       █   █  █ █  █',
	' ███  █   █ █       █    ███  ███'
];

function Header({
	botName,
	avatarUrl,
	botError,
	botReady,
	quote,
	version,
	quoteWidth,
	busy,
	completion
}: {
	botName: string;
	avatarUrl: string | null;
	botError: string | null;
	botReady: boolean;
	quote: string;
	version: string;
	quoteWidth: number;
	busy: boolean;
	completion: CompletionMessage | null;
}) {
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={1} height={10} flexShrink={0} justifyContent="space-between">
			<Box flexDirection="row" justifyContent="space-between" alignItems="center" flexGrow={1}>
				<Box flexDirection="column">
					{ascii.map((line) => (
						<Text key={line} color={C.cyan} bold>
							{line}
						</Text>
					))}
				</Box>

				<Box flexDirection="row" alignItems="center">
					<CapybaraBubble busy={busy} completion={completion} />
					<MemoizedPixelAvatar url={avatarUrl} size={12} />

					<Box flexDirection="column" marginLeft={1}>
						<Text color={C.text} bold>{short(botName, 22)}</Text>
						<Text color={botError ? C.red : botReady ? C.green : C.yellow}>
							{botError ? 'STARTUP ERROR' : botReady ? 'CONNECTED' : 'CONNECTING'}
						</Text>
						<Text color={C.muted}>v{version}</Text>
					</Box>
				</Box>
			</Box>

			<Box flexDirection="row">
				<Text color={C.muted} italic>
					{short(quote, quoteWidth)}
				</Text>
			</Box>
		</Box>
	);
}

const PersistentHeader = memo(Header);

type CompletionMessage = {
	text: string;
	success: boolean;
	id: number;
};

function CapybaraBubble({
	busy,
	completion
}: {
	busy: boolean;
	completion: CompletionMessage | null;
}) {
	const [message, setMessage] = useState('The capybaras are awake. Mostly.');

	useEffect(() => {
		if (completion) {
			setMessage(completion.text);
			return;
		}

		if (busy) {
			setMessage(pickMessage(WORKING_MESSAGES));
			return;
		}

		const update = () => {
			const pool = Math.random() < 0.12 ? EASTER_EGGS : IDLE_MESSAGES;
			setMessage(pickMessage(pool));
		};

		const timer = setInterval(update, 45_000);
		return () => clearInterval(timer);
	}, [busy, completion?.id]);

	useEffect(() => {
		if (!completion) return;

		const timer = setTimeout(() => {
			setMessage(pickMessage(IDLE_MESSAGES));
		}, 8_000);

		return () => clearTimeout(timer);
	}, [completion?.id]);

	return (
		<Box flexDirection="row" alignItems="center" marginRight={1}>
			<Box
				borderStyle="round"
				borderColor={completion ? (completion.success ? C.green : C.red) : C.border}
				paddingX={1}
				width={Math.min(44, Math.max(18, stringWidth(message) + 2))}
				flexShrink={1}
			>
				<Text
					color={completion ? (completion.success ? C.green : C.red) : C.text}
					italic
					wrap="wrap"
				>
					{message}
				</Text>
			</Box>
			<Text color={C.border}> ◀</Text>
		</Box>
	);
}


function ActivityLine({
	crons,
	completion
}: {
	crons: CronJobSnapshot[];
	completion: CompletionMessage | null;
}) {
	const [queue, setQueue] = useState(() => riotRequestQueue.getSnapshot());
	const [visible, setVisible] = useState(true);
	const [messageIndex, setMessageIndex] = useState(0);

	useEffect(() => {
	const queueTimer = setInterval(() => {
		const nextQueue = riotRequestQueue.getSnapshot();

		setQueue((current) =>
		JSON.stringify(current) === JSON.stringify(nextQueue) ? current : nextQueue
		);
	}, 750);

	return () => {
		clearInterval(queueTimer);
	};
	}, []);

	const runningCrons = crons.filter((job) => job.running);
	const working = runningCrons.length > 0 || queue.active > 0 || queue.pending > 0;

	const blinking = working;

	useEffect(() => {
		if (!blinking) {
			setVisible(true);
			return;
		}

		const timer = setInterval(() => {
			setVisible((current) => !current);
		}, 500);

		return () => clearInterval(timer);
	}, [blinking]);

	useEffect(() => {
		if (!working) {
			setMessageIndex(0);
			return;
		}

		const timer = setInterval(() => {
			setMessageIndex((value) => (value + 1) % WORKING_MESSAGES.length);
		}, 4_000);

		return () => clearInterval(timer);
	}, [working]);

	const activeCron = runningCrons[0];
	const activeRequest = queue.activeRequests[0];

	let label = 'IDLE';
	let detail = 'All systems quiet. The capybara is chilling.';
	let accent = C.green;

	if (working && activeCron) {
		label = 'WORKING';
		detail = `${WORKING_MESSAGES[messageIndex]} · ${getCronPresentation(activeCron.name).title}${runningCrons.length > 1 ? ` +${runningCrons.length - 1} more` : ''}`;
		accent = C.yellow;
	} else if (working && (activeRequest || queue.pending > 0)) {
		label = 'WORKING';
		detail = `${WORKING_MESSAGES[messageIndex]} · ${
			activeRequest
				? `Riot · ${activeRequest.region} · ${activeRequest.method} · ${queue.pending} waiting`
				: `Riot queue · ${queue.pending} waiting · rate limit ${queue.nextRateLimitDelayMs}ms`
		}`;
		accent = C.cyan;
	} else if (completion) {
		label = completion.success ? 'COMPLETED' : 'FAILED';
		detail = completion.text;
		accent = completion.success ? C.green : C.red;
	}

	return (
		<Text>
			{' '}
			<Text color={accent} bold>
				{blinking ? (visible ? '✻ ' : '  ') : '● '}
				{label}
			</Text>
			<Text color={C.muted}>  {detail}</Text>
			{working && (
				<Text color={C.muted}>
					{'  '}· Riot {queue.active}/{queue.maxConcurrent} slots
				</Text>
			)}
		</Text>
	);
}

function sparkline(values: number[]): string {
	const bars = '▁▂▃▄▅▆▇█';
	const max = Math.max(1, ...values);

	return values
		.map((value) => bars[Math.min(7, Math.floor((value / max) * 7))]!)
		.join('');
}

function formatMs(value: number): string {
	if (value < 1_000) return `${Math.round(value)}ms`;
	return `${(value / 1_000).toFixed(1)}s`;
}


function Panel({
	title,
	children,
	flexGrow = 1,
	borderColor = C.border
}: {
	title: string;
	children: React.ReactNode;
	flexGrow?: number;
	borderColor?: string;
}) {
	return (
		<Box flexDirection="column" flexGrow={flexGrow} borderStyle="round" borderColor={borderColor} paddingX={1} paddingY={0}>
			<Box marginBottom={0}>
				<Text color={C.cyan} bold>
					{title.toUpperCase()}
				</Text>
			</Box>
			{children}
		</Box>
	);
}

function Stat({ label, value, accent = C.text }: { label: string; value: string | number; accent?: string }) {
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={1} flexGrow={1}>
			<Text color={C.muted}>{label.toUpperCase()}</Text>
			<Text color={accent} bold>
				{value}
			</Text>
		</Box>
	);
}

function levelColor(level: LogLevel): string {
	if (level === 'error' || level === 'fatal') return C.red;
	if (level === 'warn') return C.yellow;
	if (level === 'debug' || level === 'trace') return C.muted;
	return C.green;
}

function short(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

const graphemeSegmenter = new Intl.Segmenter('en', {
	granularity: 'grapheme'
});

function fitColumn(value: string | number, width: number): string {
	if (width <= 0) return '';

	const text = String(value);
	const actualWidth = stringWidth(text);

	if (actualWidth <= width) {
		return text + ' '.repeat(width - actualWidth);
	}

	const ellipsis = '…';
	let result = '';

	for (const { segment } of graphemeSegmenter.segment(text)) {
		const candidate = result + segment;

		if (stringWidth(candidate + ellipsis) > width) break;

		result = candidate;
	}

	const output = result + ellipsis;

	return output + ' '.repeat(Math.max(0, width - stringWidth(output)));
}

interface AccountColumnWidths {
	first: number;
	second: number;
	region: number;
	solo: number;
	level: number;
	matches: number;
}

function getAccountColumnWidths(availableWidth: number): AccountColumnWidths {
	const minimum = [10, 10, 5, 9, 3, 6];
	const maximum = [22, 22, 7, 20, 5, 9];
	const widths = [...minimum];

	const expansionOrder = [0, 1, 3, 5, 2, 4];

	let remaining = Math.max(
		0,
		Math.min(
			availableWidth,
			maximum.reduce((sum, width) => sum + width, 0)
		) - minimum.reduce((sum, width) => sum + width, 0)
	);

	for (const index of expansionOrder) {
		const capacity = maximum[index]! - widths[index]!;
		const addition = Math.min(capacity, remaining);

		widths[index] += addition;
		remaining -= addition;

		if (remaining <= 0) break;
	}

	return {
		first: widths[0]!,
		second: widths[1]!,
		region: widths[2]!,
		solo: widths[3]!,
		level: widths[4]!,
		matches: widths[5]!
	};
}

function providerLabel(provider: string): string {
	switch (provider.toLowerCase()) {
		case 'riot':
			return 'Riot';
		case 'discord':
			return 'Discord';
		case 'ddragon':
			return 'Data Dragon';
		case 'communitydragon':
			return 'CommunityDragon';
		default:
			return provider;
	}
}

function providerShortLabel(provider: string): string {
	switch (provider.toLowerCase()) {
		case 'riot':
			return 'RIOT';
		case 'discord':
			return 'DISCORD';
		case 'ddragon':
			return 'DATADRAGON';
		case 'communitydragon':
			return 'COMMUNITYDRAGON';
		default:
			return provider.toUpperCase();
	}
}

function requestsPerMinuteColor(requests: number): string {
	if (requests <= 5) return C.green;
	if (requests <= 15) return C.yellow;
	return C.red;
}

type CronCategory = 'VERIFICATION' | 'LEAGUE DATA' | 'AUTOMATION';

interface CronPresentation {
	title: string;
	description: string;
	category: CronCategory;
}

const CRON_PRESENTATION: Record<string, CronPresentation> = {
	'verification-poll': {
		title: 'Verification polling',
		description: 'Checks pending Riot icon challenges and expires abandoned ones.',
		category: 'VERIFICATION'
	},
	'riot-champion-catalog-refresh': {
		title: 'Champion catalog refresh',
		description: 'Updates the League champion catalog and Data Dragon version.',
		category: 'LEAGUE DATA'
	},
	'riot-champion-mastery-sync': {
		title: 'Champion mastery sync',
		description: 'Synchronizes champion mastery data for linked accounts.',
		category: 'LEAGUE DATA'
	},
	'riot-match-history-sync': {
		title: 'Match history sync',
		description: 'Keeps recent match history up to date for linked accounts.',
		category: 'LEAGUE DATA'
	},
	'riot-match-backfill': {
		title: 'Match history backfill',
		description: 'Fetches older matches to progressively build player history.',
		category: 'LEAGUE DATA'
	},
	'player-automation': {
		title: 'Player automation',
		description: 'Re-evaluates player statistics, lane and role assignments.',
		category: 'AUTOMATION'
	}
};

const CRON_CATEGORIES: CronCategory[] = ['VERIFICATION', 'LEAGUE DATA', 'AUTOMATION'];

function getCronPresentation(name: string): CronPresentation {
	return (
		CRON_PRESENTATION[name] ?? {
			title: name
				.replace(/[-_]/g, ' ')
				.replace(/\b\w/g, (character) => character.toUpperCase()),
			description: 'Scheduled background task.',
			category: 'AUTOMATION'
		}
	);
}

function humanizeCronExpression(expression: string): string {
	const fields = expression.trim().split(/\s+/);

	if (fields.length !== 6) return expression;

	const [seconds, minutes, hours, dayOfMonth, month, dayOfWeek] = fields;

	if (
		seconds?.startsWith('*/') &&
		minutes === '*' &&
		hours === '*' &&
		dayOfMonth === '*' &&
		month === '*' &&
		dayOfWeek === '*'
	) {
		const interval = Number(seconds.slice(2));
		return `Every ${interval} seconds`;
	}

	if (
		seconds === '0' &&
		minutes?.startsWith('*/') &&
		hours === '*' &&
		dayOfMonth === '*' &&
		month === '*' &&
		dayOfWeek === '*'
	) {
		const interval = Number(minutes.slice(2));
		return `Every ${interval} minutes`;
	}

	if (
		seconds === '0' &&
		minutes === '0' &&
		hours?.startsWith('*/') &&
		dayOfMonth === '*' &&
		month === '*' &&
		dayOfWeek === '*'
	) {
		const interval = Number(hours.slice(2));
		return `Every ${interval} hours`;
	}

	return expression;
}

function windowStart(total: number, selected: number, size: number): number {
	return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
}

function Overview({ data, logs, maxLogRows }: { data: OverviewData | null; logs: LogEntry[]; maxLogRows: number }) {
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Box flexDirection="row" marginBottom={1}>
				<Stat label="Accounts" value={data?.accounts ?? '—'} accent={C.cyan} />
				<Stat label="Servers" value={data?.guilds ?? '—'} accent={C.purple} />
				<Stat label="Pending verify" value={data?.pendingVerifications ?? '—'} accent={C.yellow} />
				<Stat label="Matches" value={data?.matches ?? '—'} accent={C.green} />
			</Box>

			<Box flexDirection="row" marginBottom={1}>
				<Stat label="Uptime" value={data ? formatDuration(data.uptimeSeconds) : '—'} accent={C.green} />
				<Stat label="Gateway ping" value={data && data.ping >= 0 ? `${data.ping}ms` : '—'} accent={C.cyan} />
				<Stat label="Process RAM" value={data ? `${data.memoryMb}MB / ${data.totalMemoryMb}MB` : '—'} accent={C.yellow} />
				<Stat
					label="CPU usage"
					value={data?.cpuPercent === null || data?.cpuPercent === undefined ? 'Sampling…' : `${data.cpuPercent}%`}
					accent={C.purple}
				/>
			</Box>

			<Box marginBottom={1}>
				<Text color={C.muted}>
					{' '}Slash commands this session: {data?.commands ?? 0} · Match participants stored:{' '}
					{(data?.participants ?? 0).toLocaleString('en-US')}
				</Text>
			</Box>

			<Panel title="Live console · latest events" flexGrow={1}>
				{logs.slice(-maxLogRows).map((entry) => (
					<Box key={entry.id} flexDirection="row">
						<Text color={C.muted}>{formatTime(entry.timestamp)} </Text>
						<Text color={levelColor(entry.level)} bold>
							{entry.level.toUpperCase().padEnd(5)}{' '}
						</Text>
						<Text color={C.muted}>[{short(entry.scope, 14)}] </Text>
						<Text color={C.text}>
							{short(entry.message.replace(/\s+/g, ' '), Math.max(18, Math.floor((process.stdout.columns ?? 120) * 0.5)))}
						</Text>
					</Box>
				))}
				{logs.length === 0 && <Text color={C.muted}>Waiting for application events…</Text>}
			</Panel>
		</Box>
	);
}

export default function App() {
	const { exit } = useApp();
	const [page, setPage] = useState<Page>('overview');
	const [botReady, setBotReady] = useState(false);
	const [botError, setBotError] = useState<string | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>(telemetry.getLogs());
	const [logFilter, setLogFilter] = useState<LogFilter>('all');
	const [search, setSearch] = useState('');
	const [searchMode, setSearchMode] = useState(false);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [paletteIndex, setPaletteIndex] = useState(0);
	const [paletteQuery, setPaletteQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [confirm, setConfirm] = useState<'quit' | 'cron' | null>(null);
	const [notice, setNotice] = useState('');
	const [overview, setOverview] = useState<OverviewData | null>(null);
	const [accounts, setAccounts] = useState<AccountRow[]>([]);
	const [guilds, setGuilds] = useState<GuildRow[]>([]);
	const [crons, setCrons] = useState<CronJobSnapshot[]>([]);
	const [database, setDatabase] = useState<Record<string, number>>({});
	const [guildFetchBusy, setGuildFetchBusy] = useState(false);
	const [filterText, setFilterText] = useState('');
	const [shutdownBusy, setShutdownBusy] = useState(false);
	const [terminalSize, setTerminalSize] = useState(() => ({
		columns: process.stdout.columns ?? 100,
		rows: process.stdout.rows ?? 40
	}));
	const [metrics, setMetrics] = useState(() => getMetricsSnapshot());
	const [completion, setCompletion] = useState<CompletionMessage | null>(null);
	const previousCronStates = useRef(new Map<string, boolean>());
	const completionSequence = useRef(0);

	useEffect(() => {
		const updateTerminalSize = () => {
			setTerminalSize({
				columns: process.stdout.columns ?? 100,
				rows: process.stdout.rows ?? 40
			});
		};

		process.stdout.on('resize', updateTerminalSize);

		return () => {
			process.stdout.off('resize', updateTerminalSize);
		};
	}, []);

	const maxListRows = Math.max(3, Math.min(28, terminalSize.rows - 16));
	const maxCronRows = Math.max(1, Math.min(10, Math.floor((terminalSize.rows - 16) / 4)));

	const sidebarWidth = terminalSize.columns >= 120 ? 34 : terminalSize.columns >= 95 ? 30 : 26;

	const accountColumnWidths = getAccountColumnWidths(terminalSize.columns - sidebarWidth - 14);

	const refresh = useCallback(async (includeLists = false) => {
		try {
			const [nextOverview, nextCrons] = await Promise.all([loadOverview(), Promise.resolve(getCronJobs())]);

			setOverview((current) => (JSON.stringify(current) === JSON.stringify(nextOverview) ? current : nextOverview));

			setCrons((current) => (JSON.stringify(current) === JSON.stringify(nextCrons) ? current : nextCrons));

			if (includeLists) {
				const [nextAccounts, nextGuilds, nextDatabase] = await Promise.all([loadAccounts(), loadGuilds(), loadDatabaseStats()]);

				setAccounts((current) => (JSON.stringify(current) === JSON.stringify(nextAccounts) ? current : nextAccounts));

				setGuilds((current) => (JSON.stringify(current) === JSON.stringify(nextGuilds) ? current : nextGuilds));

				setDatabase((current) => (JSON.stringify(current) === JSON.stringify(nextDatabase) ? current : nextDatabase));
			}
		} catch (error) {
			setNotice(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, []);

	useEffect(() => {
		let mounted = true;
		let logRefreshTimer: NodeJS.Timeout | undefined;

		const onLog = () => {
			if (!mounted) return;

			if (logRefreshTimer) clearTimeout(logRefreshTimer);

			logRefreshTimer = setTimeout(() => {
				if (!mounted) return;

				const nextLogs = telemetry.getLogs();

				setLogs((current) =>
					current.length === nextLogs.length && current[current.length - 1]?.id === nextLogs[nextLogs.length - 1]?.id ? current : nextLogs
				);
			}, 120);
		};

		telemetry.on('log', onLog);

		void startBot({ silentLogs: true })
			.then(() => {
				if (mounted) {
					setBotReady(true);
					setNotice('Gateway connected. Control panel ready.');
					void refresh(true);
				}
			})
			.catch((error) => {
				if (mounted) {
					setBotError(error instanceof Error ? error.message : String(error));
				}
			});

		const interval = setInterval(() => {
			if (!mounted) return;
			void refresh(false);
		}, 5_000);

		return () => {
			mounted = false;
			clearInterval(interval);

			if (logRefreshTimer) clearTimeout(logRefreshTimer);

			telemetry.off('log', onLog);
		};
	}, [refresh]);

	useEffect(() => {
		if (page === 'users' || page === 'accounts' || page === 'guilds' || page === 'database') {
			void refresh(true);
		}
	}, [page, refresh]);

	const client = getBotClient();
	const botName = client?.user?.tag ?? client?.user?.username ?? 'CapyGG';
	const botUserId = client?.user?.id ?? null;

	// La URL solo cambia si cambia la identidad del usuario del bot.
	const avatarUrl = useMemo(
		() =>
			client?.user?.displayAvatarURL({
				extension: 'png',
				size: 128
			}) ?? null,
		[botUserId]
	);

	useEffect(() => {
		const updateMetrics = () => setMetrics(getMetricsSnapshot());

		telemetry.on('metrics', updateMetrics);

		return () => {
			telemetry.off('metrics', updateMetrics);
		};
	}, []);

	useEffect(() => {
		for (const job of crons) {
			const wasRunning = previousCronStates.current.get(job.name) ?? false;

			if (wasRunning && !job.running && job.lastStatus !== 'skipped') {
				const success = job.lastStatus === 'success';
				const duration = job.lastDurationMs ?? 0;
				const title = getCronPresentation(job.name).title;

				setCompletion({
					id: ++completionSequence.current,
					success,
					text: success
						? `${title} cooked in ${formatDuration(duration / 1_000)}. Nicely done.`
						: `${title} failed. Check the logs.`,
				});
			}

			previousCronStates.current.set(job.name, job.running);
		}
	}, [crons]);

	useEffect(() => {
		if (!completion) return;

		const timer = setTimeout(() => {
			setCompletion(null);
		}, 8_000);

		return () => clearTimeout(timer);
	}, [completion?.id]);

	const filteredLogs = useMemo(
		() =>
			logs.filter((entry) => {
				const levelMatch =
					logFilter === 'all' ||
					entry.level === logFilter ||
					(logFilter === 'error' && entry.level === 'fatal') ||
					(logFilter === 'debug' && entry.level === 'trace');

				const textMatch = !filterText || `${entry.scope} ${entry.message}`.toLowerCase().includes(filterText.toLowerCase());

				return levelMatch && textMatch;
			}),
		[logs, logFilter, filterText]
	);

	const isWorking =
		crons.some((job) => job.running) ||
		riotRequestQueue.getSnapshot().active > 0 ||
		riotRequestQueue.getSnapshot().pending > 0;

	const visibleAccounts = useMemo(
		() =>
			accounts.filter((account) =>
				`${account.gameName} ${account.tagLine} ${account.region} ${account.discordId}`.toLowerCase().includes(filterText.toLowerCase())
			),
		[accounts, filterText]
	);

	const visibleGuilds = useMemo(
		() => guilds.filter((guild) => `${guild.name} ${guild.id}`.toLowerCase().includes(filterText.toLowerCase())),
		[guilds, filterText]
	);

	const visibleCrons = useMemo(
		() =>
			crons.filter((job) => {
				const presentation = getCronPresentation(job.name);

				const searchableText = [
					job.name,
					job.expression,
					presentation.title,
					presentation.description,
					presentation.category
				]
					.join(' ')
					.toLowerCase();

				return searchableText.includes(filterText.toLowerCase());
			}),
		[crons, filterText]
	);

	const paletteItems = useMemo(
		() => NAV.filter((item) => `${item.label} ${item.id}`.toLowerCase().includes(paletteQuery.toLowerCase())),
		[paletteQuery]
	);

	const activeListLength =
		page === 'logs'
			? filteredLogs.length
			: page === 'users' || page === 'accounts'
				? visibleAccounts.length
				: page === 'guilds'
					? visibleGuilds.length
					: page === 'crons'
						? visibleCrons.length
						: 0;

	useEffect(() => {
		setSelectedIndex((value) => Math.min(value, Math.max(0, activeListLength - 1)));
	}, [activeListLength]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [filterText, logFilter, page]);

	const navigate = useCallback((nextPage: Page) => {
		setPage(nextPage);
		setSelectedIndex(0);
		setFilterText('');
		setSearch('');
		setSearchMode(false);
		setNotice('');
	}, []);

	const quit = useCallback(async () => {
		if (shutdownBusy) return;

		setShutdownBusy(true);
		setNotice('Shutting down CapyGG…');

		try {
			await stopBot();
		} finally {
			exit();
		}
	}, [exit, shutdownBusy]);

	const executeCron = useCallback(async () => {
		const job = visibleCrons[selectedIndex];

		if (!job) return;

		const started = await runCronJob(job.name);

		setNotice(started ? `Manual execution requested: ${job.name}` : `Could not execute ${job.name} (missing or already running).`);

		setConfirm(null);
		setCrons(getCronJobs());
	}, [visibleCrons, selectedIndex]);

	const fetchGuild = useCallback(async () => {
		const guild = visibleGuilds[selectedIndex];

		if (!guild || guildFetchBusy) return;

		setGuildFetchBusy(true);
		setNotice(`Fetching all members for ${guild.name}…`);

		try {
			const updated = await fetchGuildMemberStats(guild.id);

			if (updated) {
				setGuilds((current) => current.map((item) => (item.id === updated.id ? updated : item)));
			}

			setNotice(updated ? `Member cache refreshed for ${guild.name}.` : 'Guild is no longer available.');
		} catch (error) {
			setNotice(`Member fetch failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setGuildFetchBusy(false);
		}
	}, [visibleGuilds, selectedIndex, guildFetchBusy]);

	useInput(
		(input, key) => {
			if (key.ctrl && input.toLowerCase() === 'c') {
				setConfirm('quit');
				return;
			}

			if (searchMode) {
				if (key.escape) {
					setSearchMode(false);
					setSearch('');
					return;
				}

				if (key.return) {
					setFilterText(search);
					setSearchMode(false);
					return;
				}

				if (key.backspace || key.delete) {
					setSearch((value) => value.slice(0, -1));
					return;
				}

				if (input && !key.ctrl) setSearch((value) => value + input);

				return;
			}

			if (paletteOpen) {
				if (key.escape) {
					setPaletteOpen(false);
					return;
				}

				if (key.upArrow) {
					setPaletteIndex((value) => Math.max(0, value - 1));
				} else if (key.downArrow) {
					setPaletteIndex((value) => Math.min(Math.max(0, paletteItems.length - 1), value + 1));
				} else if (key.return) {
					const target = paletteItems[paletteIndex];

					if (target) navigate(target.id);

					setPaletteOpen(false);
				} else if (key.backspace || key.delete) {
					setPaletteQuery((value) => value.slice(0, -1));
					setPaletteIndex(0);
				} else if (input && !key.ctrl) {
					setPaletteQuery((value) => value + input);
					setPaletteIndex(0);
				}

				return;
			}

			if (confirm) {
				if (input.toLowerCase() === 'y') {
					if (confirm === 'quit') void quit();
					if (confirm === 'cron') void executeCron();
				} else if (input.toLowerCase() === 'n' || key.escape) {
					setConfirm(null);
				}

				return;
			}

			if (key.ctrl && input.toLowerCase() === 'p') {
				setPaletteOpen(true);
				setPaletteQuery('');
				setPaletteIndex(0);
				return;
			}

			if (key.escape) {
				navigate('overview');
				return;
			}

			if (key.tab) {
				const index = NAV.findIndex((item) => item.id === page);
				navigate(NAV[(index + 1) % NAV.length]!.id);
				return;
			}

			if (key.upArrow) {
				setSelectedIndex((value) =>
					page === 'logs' ? Math.min(Math.max(0, filteredLogs.length - maxListRows), value + 1) : Math.max(0, value - 1)
				);
				return;
			}

			if (key.downArrow) {
				setSelectedIndex((value) => (page === 'logs' ? Math.max(0, value - 1) : Math.min(Math.max(0, activeListLength - 1), value + 1)));
				return;
			}

			if (key.pageUp) {
				setSelectedIndex((value) =>
					page === 'logs' ? Math.min(Math.max(0, filteredLogs.length - maxListRows), value + 10) : Math.max(0, value - 10)
				);
				return;
			}

			if (key.pageDown) {
				setSelectedIndex((value) => (page === 'logs' ? Math.max(0, value - 10) : Math.min(Math.max(0, activeListLength - 1), value + 10)));
				return;
			}

			if (input === 'q') {
				setConfirm('quit');
				return;
			}

			if (input === 'r') {
				void refresh(true);
				return;
			}

			if (input === '/') {
				setSearchMode(true);
				setSearch(filterText);
				return;
			}

			if (input === 'c' && page === 'logs') {
				setLogFilter('all');
				setFilterText('');
				return;
			}

			if (input === 'f' && page === 'logs') {
				const filters: LogFilter[] = ['all', 'info', 'warn', 'error', 'debug'];

				setLogFilter((value) => filters[(filters.indexOf(value) + 1) % filters.length]!);
				return;
			}

			if (input === 'e' && page === 'crons') {
				setConfirm('cron');
				return;
			}

			if (input === 'f' && page === 'guilds') {
				void fetchGuild();
				return;
			}

			if (input === '0') {
				navigate('settings');
				return;
			}

			const number = Number(input);

			if (number >= 1 && number <= 9) {
				navigate(NAV[number - 1]!.id);
				return;
			}
		},
		{ isActive: true }
	);

	const renderLogs = () => (
		<Panel title={`Logs · ${logFilter.toUpperCase()} · ${filteredLogs.length} events`}>
			<Box flexDirection="row" marginBottom={1}>
				<Text color={C.muted}>Filter: </Text>
				<Text color={C.cyan}>{filterText || 'none'}</Text>
				<Text color={C.muted}> · F cycle level · / search · C clear filters</Text>
			</Box>

			{filteredLogs
				.slice(
					Math.max(0, filteredLogs.length - maxListRows - selectedIndex),
					Math.max(0, filteredLogs.length - maxListRows - selectedIndex) + maxListRows
				)
				.map((entry) => (
					<Box key={entry.id} flexDirection="row">
						<Text color={C.muted}>{formatTime(entry.timestamp)} </Text>
						<Text color={levelColor(entry.level)} bold>
							{entry.level.toUpperCase().padEnd(5)}{' '}
						</Text>
						<Text color={C.purple}>[{short(entry.scope, 18)}] </Text>
						<Text color={C.text}>{short(entry.message.replace(/\s+/g, ' '), Math.max(18, (process.stdout.columns ?? 120) - 48))}</Text>
					</Box>
				))}

			{filteredLogs.length === 0 && <Text color={C.muted}>No logs match the current filters.</Text>}
		</Panel>
	);

	const renderAccounts = (usersOnly = false) => {
		const columns = accountColumnWidths;

		return (
			<Panel title={usersOnly ? `Discord users · ${visibleAccounts.length}` : `LoL accounts · ${visibleAccounts.length}`}>
				<Box flexDirection="row" marginBottom={1}>
					<Text color={C.muted}>↑↓ select · / search · R refresh</Text>
				</Box>

				<Box flexDirection="row">
					<Text color={C.cyan} bold>
						{fitColumn(usersOnly ? 'DISCORD USER' : 'RIOT ID', columns.first)}
						{fitColumn(usersOnly ? 'RIOT ID' : 'DISCORD USER', columns.second)}
						{fitColumn('REGION', columns.region)}
						{fitColumn('SOLO RANK', columns.solo)}
						{fitColumn('LVL', columns.level)}
						{fitColumn('MATCHES', columns.matches)}
					</Text>
				</Box>

				{visibleAccounts
					.slice(
						windowStart(visibleAccounts.length, selectedIndex, maxListRows),
						windowStart(visibleAccounts.length, selectedIndex, maxListRows) + maxListRows
					)
					.map((account, offset) => {
						const index = windowStart(visibleAccounts.length, selectedIndex, maxListRows) + offset;

						const clientUser = client?.users.cache.get(account.discordId);

						const discordLabel = clientUser?.tag ?? account.discordId;
						const riotLabel = `${account.gameName}#${account.tagLine}`;

						const first = usersOnly ? discordLabel : riotLabel;
						const second = usersOnly ? riotLabel : discordLabel;

						return (
							<Box key={account.puuid} flexDirection="row">
								<Text color={index === selectedIndex ? C.cyan : C.text}>{fitColumn(first, columns.first)}</Text>
								<Text color={C.muted}>{fitColumn(second, columns.second)}</Text>
								<Text color={C.blue}>{fitColumn(account.region, columns.region)}</Text>
								<Text color={C.text}>{fitColumn(account.soloRank, columns.solo)}</Text>
								<Text color={C.muted}>{fitColumn(account.level ?? '—', columns.level)}</Text>
								<Text color={C.green}>{fitColumn(account.matchCount.toLocaleString('en-US'), columns.matches)}</Text>
							</Box>
						);
					})}

				{visibleAccounts.length === 0 && <Text color={C.muted}>No linked accounts found.</Text>}

				<Box marginTop={1}>
					<Text color={C.muted}>
						{usersOnly
							? 'The current schema has no standalone User model; this view lists Discord IDs with a linked RiotAccount.'
							: 'RiotAccount.discordId is required and unique, so orphaned/unlinked tracked accounts cannot currently exist in this schema.'}
					</Text>
				</Box>
			</Panel>
		);
	};

	const renderGuilds = () => (
		<Panel title={`Discord guilds · ${visibleGuilds.length}`}>
			<Box flexDirection="row" marginBottom={1}>
				<Text color={C.muted}>↑↓ select · F fetch exact member cache · / search</Text>
			</Box>

			<Box flexDirection="row">
				<Text color={C.cyan} bold>
					{'SERVER'.padEnd(30)}
					{'MEMBERS'.padEnd(12)}
					{'VERIFIED'.padEnd(14)}
					{'CONFIG'.padEnd(10)}
				</Text>
			</Box>

			{visibleGuilds
				.slice(
					windowStart(visibleGuilds.length, selectedIndex, maxListRows),
					windowStart(visibleGuilds.length, selectedIndex, maxListRows) + maxListRows
				)
				.map((guild, offset) => {
					const index = windowStart(visibleGuilds.length, selectedIndex, maxListRows) + offset;

					return (
						<Box key={guild.id} flexDirection="row">
							<Text color={index === selectedIndex ? C.cyan : C.text}>{short(guild.name, 28).padEnd(30)}</Text>
							<Text color={C.text}>{String(guild.memberCount).padEnd(12)}</Text>
							<Text color={guild.verifiedIsExact ? C.green : C.yellow}>
								{`${guild.verifiedCount}/${guild.memberCount}${guild.verifiedIsExact ? '' : '*'}`.padEnd(14)}
							</Text>
							<Text color={guild.configured ? C.green : C.muted}>{guild.configured ? 'SETUP' : '—'}</Text>
						</Box>
					);
				})}

			{visibleGuilds.length === 0 && <Text color={C.muted}>No guilds available (bot may still be connecting).</Text>}

			<Box marginTop={1}>
				<Text color={C.muted}>
					* Verified count uses the currently cached members until you press F. Requires the GuildMembers intent and access.
				</Text>
			</Box>
		</Panel>
	);

	const renderCrons = () => {
		const start = windowStart(visibleCrons.length, selectedIndex, maxCronRows);
		const jobsToRender = visibleCrons.slice(start, start + maxCronRows);

		const groupedJobs = CRON_CATEGORIES.map((category) => ({
			category,
			jobs: jobsToRender.filter((job) => getCronPresentation(job.name).category === category)
		})).filter((group) => group.jobs.length > 0);

		return (
			<Panel title={`Schedulers · ${visibleCrons.length} jobs`}>
				<Box flexDirection="row" marginBottom={1}>
					<Text color={C.muted}>↑↓ select · E execute selected job · / search</Text>
				</Box>

				{groupedJobs.map(({ category, jobs }) => (
					<Box key={category} flexDirection="column" marginBottom={1}>
						<Text color={C.purple} bold>
							{category}
						</Text>

						{jobs.map((job) => {
							const index = visibleCrons.indexOf(job);
							const presentation = getCronPresentation(job.name);

							return (
								<Box
									key={job.name}
									flexDirection="column"
									paddingX={1}
									borderStyle={index === selectedIndex ? 'round' : undefined}
									borderColor={index === selectedIndex ? C.cyan : undefined}
								>
									<Box flexDirection="row" justifyContent="space-between">
										<Text color={index === selectedIndex ? C.cyan : C.text} bold>
											{presentation.title}
										</Text>

										<Text color={job.running ? C.yellow : job.lastStatus === 'failed' ? C.red : C.green}>
											{job.running ? 'RUNNING' : job.lastStatus.toUpperCase()}
										</Text>
									</Box>

									<Text color={C.muted}>
										{presentation.description}
									</Text>

									<Text color={C.muted}>
										{humanizeCronExpression(job.expression)}
										{job.timezone ? ` · ${job.timezone}` : ''}
										{' · '}Runs: {job.runCount}
										{' · '}Failures: {job.failureCount}
										{' · '}Last: {formatTime(job.lastRunAt)}
										{' · '}Next: {formatTime(job.nextRunAt)}
									</Text>

									{job.lastSummary !== null && job.lastSummary !== '' && (
										<Text color={C.muted}>
											Result: {short(job.lastSummary, 100)}
										</Text>
									)}
								</Box>
							);
						})}
					</Box>
				))}

				{visibleCrons.length === 0 && (
					<Text color={C.muted}>No cron jobs match the current search.</Text>
				)}
			</Panel>
		);
	};


	const renderQueue = () => {
		const queue = riotRequestQueue.getSnapshot();

		const priorities = [
			{ key: 'critical', label: 'CRITICAL', color: C.red },
			{ key: 'normal', label: 'NORMAL', color: C.cyan },
			{ key: 'background', label: 'BACKGROUND', color: C.purple }
		] as const;

		const regions = Object.entries(queue.pendingByRegion)
			.sort((a, b) => b[1] - a[1]);

		return (
			<Box flexDirection="column" flexGrow={1}>
				<Box flexDirection="row" marginBottom={1}>
					<Stat label="Active slots" value={`${queue.active}/${queue.maxConcurrent}`} accent={C.green} />
					<Stat label="Waiting" value={queue.pending} accent={C.yellow} />
					<Stat label="Completed" value={queue.completed} accent={C.cyan} />
					<Stat label="Failed" value={queue.failed} accent={queue.failed > 0 ? C.red : C.green} />
				</Box>

				<Box flexDirection="row" marginBottom={1}>
					<Stat label="Oldest wait" value={formatMs(queue.oldestPendingMs)} accent={queue.oldestPendingMs > 5_000 ? C.yellow : C.cyan} />
					<Stat label="Rate-limit gate" value={formatMs(queue.nextRateLimitDelayMs)} accent={queue.nextRateLimitDelayMs > 0 ? C.yellow : C.green} />
					<Stat label="Success rate" value={`${queue.completed + queue.failed > 0 ? ((queue.completed / (queue.completed + queue.failed)) * 100).toFixed(1) : '—'}%`} accent={C.green} />
				</Box>

				<Panel title={`In-flight requests · ${queue.active}/${queue.maxConcurrent}`} flexGrow={1}>
					{queue.activeRequests.map((request) => (
						<Box key={`${request.region}-${request.method}-${request.startedAt}`} flexDirection="column" marginBottom={1}>
							<Box flexDirection="row" justifyContent="space-between">
								<Text color={C.cyan} bold>
									{request.method}
								</Text>
								<Text color={request.priority === 'critical' ? C.red : request.priority === 'normal' ? C.cyan : C.purple}>
									{request.priority.toUpperCase()}
								</Text>
							</Box>
							<Text color={C.muted}>
								{request.region} · Running for {formatMs(Date.now() - request.startedAt)}
							</Text>
						</Box>
					))}

					{queue.activeRequests.length === 0 && (
						<Text color={C.muted}>No active requests. The queue is taking a well-deserved nap.</Text>
					)}
				</Panel>

				<Box flexDirection="row" marginTop={1}>
					<Panel title="Priority distribution">
						{priorities.map(({ key, label, color }) => (
							<Box key={key} flexDirection="row" justifyContent="space-between">
								<Text color={color} bold>{label}</Text>
								<Text color={C.text}>{queue.pendingByPriority[key]} waiting</Text>
							</Box>
						))}
					</Panel>

					<Panel title="Waiting by region">
						{regions.map(([region, count]) => (
							<Box key={region} flexDirection="row" justifyContent="space-between">
								<Text color={C.text}>{region.toUpperCase()}</Text>
								<Text color={C.cyan} bold>{count}</Text>
							</Box>
						))}
						{regions.length === 0 && (
							<Text color={C.muted}>No requests waiting.</Text>
						)}
					</Panel>
				</Box>

				<Box marginTop={1}>
					<Text color={C.muted}>
						Requests are scheduled by priority and Riot rate-limit eligibility. Maximum concurrency: {queue.maxConcurrent}.
					</Text>
				</Box>
			</Box>
		);
	};



	const renderMetrics = () => {
		const totalRequests = metrics.reduce((sum, metric) => sum + metric.totalRequests, 0);
		const requestsLastMinute = metrics.reduce((sum, metric) => sum + metric.requestsPerMinute, 0);
		const recentErrors = metrics.reduce((sum, metric) => sum + metric.errorsLastMinute, 0);
		const recent429 = metrics.reduce((sum, metric) => sum + metric.rateLimitedLastMinute, 0);

		return (
			<Box flexDirection="column" flexGrow={1}>
				<Box flexDirection="row" marginBottom={1}>
					<Stat label="Requests / min" value={requestsLastMinute} accent={C.cyan} />
					<Stat label="Session requests" value={totalRequests} accent={C.green} />
					<Stat label="Errors · 60s" value={recentErrors} accent={recentErrors ? C.red : C.green} />
					<Stat label="Rate limits · 60s" value={recent429} accent={recent429 ? C.yellow : C.green} />
				</Box>

				<Panel title="Provider performance · rolling 60 seconds" flexGrow={1}>
					<Box flexDirection="row">
						<Text color={C.cyan} bold>
							{'PROVIDER'.padEnd(19)}
							{'ACTIVITY'.padEnd(16)}
							{'RPM'.padEnd(7)}
							{'TOTAL'.padEnd(8)}
							{'ERR'.padEnd(6)}
							{'429'.padEnd(6)}
							{'ERR%'.padEnd(7)}
						</Text>
					</Box>

					{metrics.map((metric) => (
						<Box key={metric.provider} flexDirection="row">
							<Text color={C.text}>{providerLabel(metric.provider).padEnd(19)}</Text>
							<Text color={C.cyan}>{sparkline(metric.requestsByInterval).padEnd(16)}</Text>
							<Text color={requestsPerMinuteColor(metric.requestsPerMinute)}>{String(metric.requestsPerMinute).padEnd(7)}</Text>
							<Text color={C.text}>{String(metric.totalRequests).padEnd(8)}</Text>
							<Text color={metric.errors ? C.red : C.text}>{String(metric.errors).padEnd(6)}</Text>
							<Text color={metric.rateLimited ? C.yellow : C.text}>{String(metric.rateLimited).padEnd(6)}</Text>
							<Text color={metric.errorRate > 5 ? C.red : C.text}>{`${metric.errorRate}%`.padEnd(7)}</Text>
						</Box>
					))}

					<Box marginTop={1}>
						<Text color={C.muted}>
							Activity sparkline: 12 buckets × 5 seconds. Error and 429 totals are session-wide; recent counters are shown above.
						</Text>
					</Box>
				</Panel>

				<Box flexDirection="row" marginTop={1}>
					<Panel title="Latency">
						{metrics.map((metric) => (
							<Box key={metric.provider} flexDirection="row" justifyContent="space-between">
								<Text color={C.text}>{providerLabel(metric.provider)}</Text>
								<Text color={C.cyan}>
									AVG {formatMs(metric.averageLatencyMs)} · P95 {formatMs(metric.p95LatencyMs)}
								</Text>
							</Box>
						))}
					</Panel>

					<Panel title="Last HTTP response">
						{metrics.map((metric) => (
							<Box key={metric.provider} flexDirection="row" justifyContent="space-between">
								<Text color={C.text}>{providerLabel(metric.provider)}</Text>
								<Text color={
									metric.lastStatus === null ? C.muted :
									metric.lastStatus >= 500 ? C.red :
									metric.lastStatus >= 400 ? C.yellow :
									C.green
								}>
									{metric.lastStatus === null ? 'NO DATA' : `HTTP ${metric.lastStatus}`}
								</Text>
							</Box>
						))}
					</Panel>
				</Box>

				<Box marginTop={1}>
					<Text color={C.muted}>
						HTTP/REST request boundaries only. Cached reads are excluded; Discord Gateway heartbeat frames are not REST requests.
					</Text>
				</Box>
			</Box>
		);
	};


	const renderDatabase = () => (
		<Panel title="SQLite · Prisma record counts">
			{Object.entries(database).map(([name, count]) => (
				<Box key={name} flexDirection="row" justifyContent="space-between">
					<Text color={C.text}>{name.replace(/([A-Z])/g, ' $1').toUpperCase()}</Text>
					<Text color={C.cyan} bold>
						{count.toLocaleString('en-US')}
					</Text>
				</Box>
			))}

			{!Object.keys(database).length && <Text color={C.muted}>Loading database statistics…</Text>}

			<Box marginTop={1}>
				<Text color={C.muted}>Counts are read-only. No database mutations are exposed in the TUI.</Text>
			</Box>
		</Panel>
	);

	const renderSettings = () => (
		<Panel title="Runtime configuration · secrets hidden">
			{getRuntimeSettings().map((setting) => (
				<Box key={setting.name} flexDirection="row">
					<Text color={C.cyan}>{setting.name.padEnd(34)}</Text>
					<Text color={C.text}>{setting.value}</Text>
				</Box>
			))}

			<Box marginTop={1}>
				<Text color={C.muted}>
					This first TUI release is intentionally read-only for environment settings. Edit your .env file and restart the process to apply
					changes.
				</Text>
			</Box>
		</Panel>
	);

	const renderPage = () => {
		switch (page) {
			case 'overview':
				return <Overview data={overview} logs={logs} maxLogRows={Math.max(2, Math.min(12, terminalSize.rows - 22))} />;
			case 'logs':
				return renderLogs();
			case 'users':
				return renderAccounts(true);
			case 'accounts':
				return renderAccounts(false);
			case 'guilds':
				return renderGuilds();
			case 'queue':
				return renderQueue();
			case 'crons':
				return renderCrons();
			case 'metrics':
				return renderMetrics();
			case 'database':
				return renderDatabase();
			case 'settings':
				return renderSettings();
		}
	};

	const visibleSidebarCrons = [...crons]
		.sort((a, b) => Number(b.running) - Number(a.running))
		.slice(0, 3);

	return (
		<Box flexDirection="column" paddingX={1} width={terminalSize.columns} height={terminalSize.rows}>
			<PersistentHeader
				botName={botName}
				avatarUrl={avatarUrl}
				botError={botError}
				botReady={botReady}
				quote={startupQuote}
				version={BOT_VERSION}
				quoteWidth={Math.max(24, terminalSize.columns - 12)}
				busy={isWorking}
				completion={completion}
			/>

			<ActivityLine crons={crons} completion={completion} />

			<Box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} marginTop={1}>
				<Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column">
					{botError ? (
						<Panel title="Startup failed" borderColor={C.red}>
							<Text color={C.red}>{botError}</Text>
							<Text color={C.muted}>Check your .env configuration and restart with npm run tui.</Text>
						</Panel>
					) : (
						renderPage()
					)}
				</Box>

				<Box width={sidebarWidth} flexShrink={0} flexDirection="column" marginLeft={1}>
					<Panel title={`CRONS · ${crons.length}`} flexGrow={0}>
						{visibleSidebarCrons.map((job) => {
							const presentation = getCronPresentation(job.name);

							return (
								<Box key={job.name} flexDirection="row" justifyContent="space-between">
									<Text color={C.text}>
										{short(presentation.title, sidebarWidth - 12)}
									</Text>

									<Text color={job.running ? C.yellow : job.lastStatus === 'failed' ? C.red : C.green}>
										{job.running ? 'RUN' : job.lastStatus === 'failed' ? 'ERR' : 'OK'}
									</Text>
								</Box>
							);
						})}

						{crons.length === 0 && (
							<Text color={C.muted}>Waiting for Discord…</Text>
						)}

						<Text color={C.muted}>Press 7 for details.</Text>
					</Panel>

					<Panel title="Navigation" flexGrow={1}>
						{NAV.map((item) => {
							const selected = page === item.id;

							return (
								<Box key={item.id}>
									<Text
										color={selected ? C.bg : C.text}
										backgroundColor={selected ? C.cyan : undefined}
										bold={selected}
									>
										{` ${item.key}  ${item.label.padEnd(Math.max(8, sidebarWidth - 10))} `}
									</Text>
								</Box>
							);
						})}
					</Panel>
				</Box>
			</Box>

			{notice.length > 0 && (
				<Box marginTop={1}>
					<Text color={C.yellow}>{notice}</Text>
				</Box>
			)}

			{searchMode && (
				<Box borderStyle="round" borderColor={C.cyan} paddingX={1}>
					<Text color={C.cyan}>SEARCH &gt; </Text>
					<Text color={C.text}>{search}</Text>
					<Text color={C.muted}> Enter apply · Esc cancel</Text>
				</Box>
			)}

			{paletteOpen && (
				<Box borderStyle="round" borderColor={C.purple} paddingX={1} flexDirection="column">
					<Text color={C.purple} bold>
						COMMAND PALETTE · {paletteQuery || 'type to search'}
					</Text>

					{paletteItems.map((item, index) => (
						<Text
							key={item.id}
							color={index === paletteIndex ? C.cyan : C.text}
							backgroundColor={index === paletteIndex ? '#26364A' : undefined}
						>
							{index === paletteIndex ? '> ' : '  '}
							{item.label}
						</Text>
					))}

					{paletteItems.length === 0 && <Text color={C.muted}>No matching section.</Text>}
				</Box>
			)}

			{confirm && (
				<Box borderStyle="round" borderColor={C.yellow} paddingX={1}>
					<Text color={C.yellow} bold>
						{confirm === 'quit'
							? 'Stop the bot and exit? [y/N]'
							: `Execute ${visibleCrons[selectedIndex]?.name ?? 'selected cron'} now? [y/N]`}
					</Text>
				</Box>
			)}

			<Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C.border} paddingX={1} flexShrink={0}>
				<Box flexDirection="row" justifyContent="space-between">
					<Box flexDirection="row">
						<Text color={botReady && !botError ? C.green : botError ? C.red : C.yellow}>
							{botReady && !botError ? '[OK] ' : botError ? '[ERROR] ' : '[WAIT] '}
						</Text>
						<Text color={C.muted}>
							{botReady && !botError ? 'ALL SYSTEMS OPERATIONAL' : botError ? 'SYSTEM STARTUP FAILED' : 'CONNECTING TO DISCORD…'}
						</Text>
					</Box>

					<Box flexDirection="row">
						{metrics.map((metric) => (
							<Box key={metric.provider} flexDirection="row">
								<Text color={C.muted}>{providerShortLabel(metric.provider)} </Text>
								<Text color={requestsPerMinuteColor(metric.requestsPerMinute)} bold>
									{metric.requestsPerMinute}/m
								</Text>
								<Text> </Text>
							</Box>
						))}
					</Box>
				</Box>

				<Text color={C.muted}>↑↓ select · Tab next section · / search · Ctrl+P command palette · R refresh · Q quit</Text>
			</Box>
		</Box>
	);
}
