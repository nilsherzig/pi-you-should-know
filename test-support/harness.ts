import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ExtensionToolContext,
	ExtensionUIContext,
	MessageRenderer,
	RegisteredCommand,
	TerminalInputHandler,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface TestNotification {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

export interface TestWidget {
	content: unknown;
	placement: "aboveEditor" | "belowEditor" | undefined;
}

export interface TestUiState {
	statuses: Map<string, string | undefined>;
	notifications: TestNotification[];
	widgets: Map<string, TestWidget>;
	title: string | undefined;
	editorText: string;
	toolsExpanded: boolean;
	emitTerminalInput(data: string): ReturnType<TerminalInputHandler>[];
}

export interface TestSentMessage {
	message: unknown;
	options: unknown;
}

export interface TestEntry {
	customType: string;
	data: unknown;
}

export interface TestUserMessage {
	content: unknown;
	options: unknown;
}

export interface ExtensionTestHarnessOptions {
	cwd?: string;
	mode?: ExtensionContext["mode"];
	idle?: boolean;
	entries?: unknown[];
	api?: Partial<ExtensionAPI>;
	context?: Partial<ExtensionCommandContext>;
}

type RegisteredTestCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
type TestEventHandler = (event: unknown, context: ExtensionContext) => unknown;

export interface ExtensionTestHarness {
	pi: ExtensionAPI;
	context: ExtensionContext & ExtensionToolContext;
	commandContext: ExtensionCommandContext;
	ui: TestUiState;
	tools: ReadonlyMap<string, ToolDefinition>;
	messageRenderers: ReadonlyMap<string, MessageRenderer>;
	entryRenderers: ReadonlyMap<string, unknown>;
	entries: readonly TestEntry[];
	commands: ReadonlyMap<string, RegisteredTestCommand>;
	eventHandlers: ReadonlyMap<string, readonly TestEventHandler[]>;
	messages: TestSentMessage[];
	userMessages: TestUserMessage[];
	readonly sessionName: string | undefined;
	readonly shutdownCalls: number;
	readonly newSessionCalls: number;
	setIdle(idle: boolean): void;
	emit(event: string, payload?: unknown, context?: ExtensionContext): Promise<unknown[]>;
	tool<T extends ToolDefinition = ToolDefinition>(name: string): T;
	command<T extends RegisteredTestCommand = RegisteredTestCommand>(name: string): T;
}

function requireRegistration<T>(registrations: ReadonlyMap<string, T>, kind: string, name: string): T {
	const registration = registrations.get(name);
	if (registration) return registration;
	throw new Error(`No ${kind} named ${JSON.stringify(name)} was registered.`);
}

export function createExtensionTestHarness(
	options: ExtensionTestHarnessOptions = {},
): ExtensionTestHarness {
	const tools = new Map<string, ToolDefinition>();
	const messageRenderers = new Map<string, MessageRenderer>();
	const entryRenderers = new Map<string, unknown>();
	const customEntries: TestEntry[] = [];
	const commands = new Map<string, RegisteredTestCommand>();
	const eventHandlers = new Map<string, TestEventHandler[]>();
	const messages: TestSentMessage[] = [];
	const userMessages: TestUserMessage[] = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, TestWidget>();
	const notifications: TestNotification[] = [];
	const terminalInputHandlers = new Set<TerminalInputHandler>();
	const entries = options.entries ?? [];
	let editorText = "";
	let toolsExpanded = false;
	let sessionName: string | undefined;
	let idle = options.idle ?? true;
	let shutdownCalls = 0;
	let newSessionCalls = 0;

	const plainText = (...values: unknown[]): string => {
		const value = values.at(-1);
		return typeof value === "string" ? value : String(value ?? "");
	};
	const theme = new Proxy<Record<string, typeof plainText>>({}, { get: () => plainText });
	const uiState: TestUiState = {
		statuses,
		notifications,
		widgets,
		title: undefined,
		editorText,
		toolsExpanded,
		emitTerminalInput: (data) => [...terminalInputHandlers].map((handler) => handler(data)),
	};
	const ui = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string, type?: TestNotification["type"]) => {
			notifications.push({ message, type });
		},
		onTerminalInput: (handler: TerminalInputHandler) => {
			terminalInputHandlers.add(handler);
			return () => terminalInputHandlers.delete(handler);
		},
		setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: (
			key: string,
			content: unknown,
			options?: { placement?: TestWidget["placement"] },
		) => {
			if (content === undefined) {
				widgets.delete(key);
				return;
			}
			widgets.set(key, { content, placement: options?.placement });
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: (value: string) => {
			uiState.title = value;
		},
		custom: async () => undefined,
		pasteToEditor: () => {},
		setEditorText: (text: string) => {
			editorText = text;
			uiState.editorText = text;
		},
		getEditorText: () => editorText,
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => toolsExpanded,
		setToolsExpanded: (expanded: boolean) => {
			toolsExpanded = expanded;
			uiState.toolsExpanded = expanded;
		},
	} as unknown as ExtensionUIContext;

	const context = Object.assign(
		{
			ui,
			mode: options.mode ?? "tui",
			hasUI: true,
			cwd: options.cwd ?? process.cwd(),
			sessionManager: { getEntries: () => entries },
			modelRegistry: {},
			tools: [],
			executeTool: async () => { throw new Error("ctx.executeTool requires a test stub."); },
			model: undefined,
			scopedModels: [],
			isIdle: () => idle,
			isProjectTrusted: () => true,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {
				shutdownCalls++;
			},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
			getSystemPromptOptions: () => ({}),
			waitForIdle: async () => {},
			newSession: async () => {
				newSessionCalls++;
				return { cancelled: false };
			},
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		},
		options.context ?? {},
	) as unknown as ExtensionCommandContext & ExtensionToolContext;

	const api = Object.assign(
		{
			on: (event: string, handler: TestEventHandler) => {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
			registerTool: (tool: ToolDefinition) => {
				if (tools.has(tool.name)) throw new Error(`Tool ${JSON.stringify(tool.name)} was registered twice.`);
				tools.set(tool.name, tool);
			},
			registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
				if (messageRenderers.has(customType)) {
					throw new Error(`Message renderer ${JSON.stringify(customType)} was registered twice.`);
				}
				messageRenderers.set(customType, renderer);
			},
			registerEntryRenderer: (customType: string, renderer: unknown) => {
				if (entryRenderers.has(customType)) {
					throw new Error(`Entry renderer ${JSON.stringify(customType)} was registered twice.`);
				}
				entryRenderers.set(customType, renderer);
			},
			appendEntry: (customType: string, data: unknown) => {
				customEntries.push({ customType, data });
			},
			registerCommand: (name: string, command: RegisteredTestCommand) => {
				if (commands.has(name)) throw new Error(`Command ${JSON.stringify(name)} was registered twice.`);
				commands.set(name, command);
			},
			sendMessage: (message: unknown, messageOptions?: unknown) => {
				messages.push({ message, options: messageOptions });
			},
			sendUserMessage: (content: unknown, messageOptions?: unknown) => {
				userMessages.push({ content, options: messageOptions });
			},
			setSessionName: (name: string) => {
				sessionName = name;
			},
			getSessionName: () => sessionName,
			exec: async () => {
				throw new Error("pi.exec requires a test stub. Pass api: { exec: ... } to the harness.");
			},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => "off",
			setThinkingLevel: () => {},
		},
		options.api ?? {},
	) as unknown as ExtensionAPI;

	return {
		pi: api,
		context,
		commandContext: context,
		ui: uiState,
		tools,
		messageRenderers,
		entryRenderers,
		entries: customEntries,
		commands,
		eventHandlers,
		messages,
		userMessages,
		get sessionName() {
			return sessionName;
		},
		get shutdownCalls() {
			return shutdownCalls;
		},
		get newSessionCalls() {
			return newSessionCalls;
		},
		setIdle: (value) => {
			idle = value;
		},
		emit: async (event, payload = {}, eventContext = context) => {
			const handlers = eventHandlers.get(event) ?? [];
			return Promise.all(handlers.map((handler) => handler(payload, eventContext)));
		},
		tool: <T extends ToolDefinition = ToolDefinition>(name: string) =>
			requireRegistration(tools, "tool", name) as T,
		command: <T extends RegisteredTestCommand = RegisteredTestCommand>(name: string) =>
			requireRegistration(commands, "command", name) as T,
	};
}

export async function loadExtensionForTest(
	factory: ExtensionFactory,
	options: ExtensionTestHarnessOptions = {},
): Promise<ExtensionTestHarness> {
	const harness = createExtensionTestHarness(options);
	await factory(harness.pi);
	return harness;
}
