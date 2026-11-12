export const inject = [
	"react",
	"panels",
	"relay",
	"conversation",
	"navigation",
];

// Only this exported module is installed. No runtime imports or client patches.
export function safeUrl(value) {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) &&
			!url.username &&
			!url.password
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

export function categoryOf(file) {
	if (file.kind === "image" || file.kind === "video") return file.kind;
	return /\.(md|txt|pdf|docx?|xlsx?|csv|pptx?|json|[cm]?[jt]sx?|py|rs|html?|css|ya?ml|sh|go|java|sql)$/i.test(
		file.name ?? "",
	) || /^(text\/|application\/(pdf|json))/.test(file.mime ?? "")
		? "document"
		: "other";
}

// Links in examples are not deliverables. Rendering never interprets raw HTML.
export function linksIn(text) {
	if (typeof text !== "string" || text.length > 65536) return [];
	let fence;
	const lines = [];
	for (const line of text.split("\n")) {
		const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (mark) {
			if (!fence) fence = mark;
			else if (mark[0] === fence[0] && mark.length >= fence.length)
				fence = undefined;
			continue;
		}
		if (!fence) lines.push(line);
	}
	let body = lines
		.join("\n")
		.replace(/(`+)[\s\S]*?\1/g, "")
		.replace(/<(https?:\/\/[^<>\s]+)>/g, "$1")
		.replace(/<[^>]*>/g, "");
	const result = [];
	body = body.replace(
		/!?\[([^\]\n]*)\]\((https?:\/\/[^\s]+?)(?:\s+"[^"]*")?\)/g,
		(_all, name, url) => {
			result.push({ url, name });
			return "";
		},
	);
	for (const match of body.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
		result.push({ url: match[0].replace(/[.,;!?，。；！）)\]}]+$/, "") });
	}
	return result;
}

export function artifactsFrom(rows, profiles = new Map()) {
	const entries = [];
	for (const row of rows) {
		const seen = new Set();
		const add = (raw, name, attachment) => {
			const url = safeUrl(raw);
			if (!url || seen.has(url)) return;
			seen.add(url);
			const parsed = new URL(url);
			let filename = parsed.pathname.split("/").at(-1);
			try {
				filename = decodeURIComponent(filename);
			} catch {
				/* preserve filename */
			}
			entries.push({
				id: `${row.id}:${url}`,
				url,
				name: name?.trim() || filename || parsed.hostname,
				category: attachment
					? categoryOf(attachment)
					: parsed.pathname === "/" || /\.html?$/i.test(parsed.pathname)
						? "website"
						: "link",
				attachment,
				message: row,
				agent: !!row.agentEnvelope || !!profiles.get(row.authorId)?.isAgent,
			});
		};
		for (const attachment of row.attachments ?? [])
			add(attachment.url, attachment.name, attachment);
		for (const link of linksIn(row.content)) add(link.url, link.name);
	}
	return entries;
}

export function canRead(connection, channelId) {
	if (
		connection?.status !== "ready" ||
		connection.cached ||
		!connection.session
	)
		return false;
	const { session } = connection;
	const channel =
		session.channels.get?.(channelId) ??
		session.channels.list().channels.find((c) => c.id === channelId);
	return (
		!!channel &&
		!channel.cached &&
		!channel.metadataCached &&
		!channel.pending &&
		!channel.metadataPending &&
		(channel.visibility === "public" ||
			!!channel.members?.includes(session.viewer))
	);
}

// Discovery obtains IDs/cursors only. The host's exact reader folds edits,
// deletions, attribution and attachments. Never reimplement those semantics.
// Twelve disposable readers keep one page bounded, including thread replies.
export function createReader(relay, connection, channelId, pageSize = 12) {
	const { session } = connection;
	let disposed = false,
		epoch = 0,
		controller,
		readers = [],
		stops = [];
	let pageCursors = [undefined],
		page = 0,
		nextCursor,
		retryIndex = 0,
		retryHead = false;
	let state = {
		rows: [],
		pending: false,
		more: false,
		error: "",
		page: 1,
		scanned: 0,
		changed: false,
	};
	const listeners = new Set();
	const current = () => {
		const now = relay.snapshot();
		return (
			!disposed &&
			now.session === session &&
			now.scope === connection.scope &&
			now.generation === connection.generation &&
			canRead(now, channelId)
		);
	};
	const publish = (patch) => {
		if (disposed) return;
		state = { ...state, ...patch };
		for (const listener of listeners) listener();
	};
	const retire = () => {
		controller?.abort();
		controller = undefined;
		for (const stop of stops) stop();
		stops = [];
		for (const view of readers) view.dispose();
		readers = [];
	};
	const revoke = () => {
		epoch++;
		retire();
		publish({
			rows: [],
			pending: false,
			more: false,
			error: "连接或阅读权限已变化，请重新打开产物面板",
		});
	};
	const update = () => {
		if (!current()) return revoke();
		const snapshots = readers.map((view) => view.snapshot());
		const rows = snapshots
			.filter(
				(s) => s.targetStatus === "ready" && s.target?.channelId === channelId,
			)
			.map((s) => s.target);
		publish({
			rows: rows.sort(
				(a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
			),
		});
	};
	async function load(index = page, head = false) {
		if (disposed || state.pending) return;
		if (!current()) return revoke();
		retryIndex = index;
		retryHead = head;
		const ownedEpoch = ++epoch;
		retire();
		const owned = new AbortController();
		controller = owned;
		const cursor = head ? undefined : pageCursors[index];
		publish({ rows: [], pending: true, error: "", changed: false });
		try {
			const result = await session.readRemote(
				[
					{
						kinds: [9, 40002],
						"#h": [channelId],
						limit: pageSize,
						...(cursor ?? {}),
					},
				],
				{ signal: owned.signal, fresh: true },
			);
			if (ownedEpoch !== epoch || !current() || owned.signal.aborted) return;
			const events = [
				...new Map(
					result
						.filter(
							(e) =>
								[9, 40002].includes(e.kind) &&
								/^[0-9a-f]{64}$/.test(e.id) &&
								e.tags.some(([k, v]) => k === "h" && v === channelId),
						)
						.map((e) => [e.id, e]),
				).values(),
			].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
			if (
				events.length > pageSize ||
				(cursor &&
					events.some(
						(e) =>
							e.created_at > cursor.until ||
							(e.created_at === cursor.until && e.id <= cursor.before_id),
					))
			)
				throw new Error("历史分页游标不兼容");
			if (head) {
				pageCursors = [undefined];
				index = 0;
			}
			page = index;
			const last = events.at(-1);
			nextCursor = last
				? { until: last.created_at, before_id: last.id }
				: undefined;
			publish({
				page: page + 1,
				scanned: events.length,
				more: events.length === pageSize,
			});
			for (const event of events) {
				const view = session.thread(channelId, event.id, { exact: true });
				readers.push(view);
				stops.push(view.subscribe(update));
			}
			// Host readers own scheduling, access and cancellation. Bound concurrent
			// refreshes so a board does not flood the shared interactive read queue.
			const queue = [...readers];
			await Promise.all(
				Array.from({ length: Math.min(3, queue.length) }, async () => {
					while (queue.length && ownedEpoch === epoch && current())
						await queue.shift().refresh();
				}),
			);
			if (ownedEpoch !== epoch || !current() || owned.signal.aborted) return;
			update();
			const failures = readers.filter(
				(v) => v.snapshot().targetStatus === "error",
			).length;
			publish({
				pending: false,
				error: failures ? `${failures} 条消息读取失败，请重试本页` : "",
			});
		} catch {
			if (ownedEpoch === epoch && !owned.signal.aborted && current())
				publish({ pending: false, error: "产物读取失败，请重试本页" });
		} finally {
			if (controller === owned) controller = undefined;
		}
	}
	const offChannel = session.channels.subscribeList(() => {
		if (!current()) revoke();
	});
	const offRelay = relay.subscribe(() => {
		if (!current()) revoke();
	});
	const offLive = session.subscribeLive(({ events }) => {
		if (
			current() &&
			events.some(
				(e) =>
					[9, 40002].includes(e.kind) &&
					e.tags.some(([k, v]) => k === "h" && v === channelId),
			)
		)
			publish({ changed: true });
	});
	return {
		snapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start: () => load(0, true),
		retry: () => load(retryIndex, retryHead),
		refresh: () => load(0, true),
		next() {
			if (!state.pending && state.more && nextCursor) {
				pageCursors[page + 1] = nextCursor;
				return load(page + 1);
			}
		},
		previous() {
			if (!state.pending && page > 0) return load(page - 1);
		},
		dispose() {
			disposed = true;
			epoch++;
			retire();
			offChannel();
			offRelay();
			offLive();
			listeners.clear();
		},
	};
}

export async function readText(source, signal, request = fetch) {
	// Only the host's authenticated media proxy; no arbitrary URL fetch, HTML execution,
	// signed HTTP requests, network grants, or access to local filesystem paths.
	const url = new URL(source, globalThis.location?.href);
	const native =
		((url.protocol === "buzz-media:" && url.hostname === "localhost") ||
			url.origin === "http://buzz-media.localhost") &&
		!url.port &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash;
	let validNative = false;
	if (native) {
		try {
			const encoded = url.pathname.slice(1),
				target = decodeURIComponent(encoded),
				media = new URL(target);
			validNative =
				!!encoded &&
				encodeURIComponent(target) === encoded &&
				media.href === target &&
				media.protocol === "https:" &&
				!media.username &&
				!media.password &&
				!media.search &&
				!media.hash &&
				/^\/media\/[0-9a-f]{64}(?:\.(?:[a-z0-9]{1,8}|thumb\.jpg))?$/.test(
					media.pathname,
				);
		} catch {
			/* not a host-generated media source */
		}
	}
	const proxy =
		globalThis.location &&
		url.origin === location.origin &&
		url.pathname.startsWith("/api/relay") &&
		url.pathname.endsWith("/media");
	if (!validNative && !proxy) throw new Error("此文件请通过原消息打开");
	const response = await request(source, {
		signal,
		credentials: "same-origin",
	});
	if (!response.ok || !response.body) throw new Error("文档读取失败");
	const reader = response.body.getReader();
	const chunks = [],
		max = 65536;
	let bytes = 0,
		truncated = false;
	try {
		while (true) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			const part = value.subarray(0, max - bytes);
			chunks.push(part);
			bytes += part.length;
			if (bytes >= max) {
				truncated = true;
				break;
			}
		}
	} finally {
		await reader.cancel();
	}
	const data = new Uint8Array(bytes);
	let at = 0;
	for (const part of chunks) {
		data.set(part, at);
		at += part.length;
	}
	return { text: new TextDecoder().decode(data), truncated };
}

export function apply(ctx) {
	const R = ctx.react,
		h = R.createElement;
	const prefix = "opcb:chat-artifacts:";
	const labels = {
		all: "全部",
		image: "图片",
		video: "视频",
		document: "文档",
		website: "网站",
		link: "链接",
		other: "其他",
	};
	const gap = "var(--space-2)",
		inset = "var(--space-panel-inset)";
	const rowStyle = {
		display: "flex",
		gap,
		flexWrap: "wrap",
		alignItems: "center",
	};
	const note = (text) =>
		h("p", { role: "status", style: { color: "var(--text-subtle)" } }, text);
	const button = (text, onClick, props = {}) =>
		h("button", { type: "button", onClick, ...props }, text);
	function Launcher({ context, available, pressed, toggle }) {
		return button(
			"产物",
			() => {
				if (available()) toggle(prefix + context.channelId);
			},
			{ "aria-label": "聊天产物", "aria-expanded": pressed, title: "聊天产物" },
		);
	}
	function TextPreview({ source }) {
		const [data, setData] = R.useState({ pending: true });
		const [retry, setRetry] = R.useState(0);
		R.useEffect(() => {
			const controller = new AbortController();
			setData({ pending: true });
			readText(source, controller.signal)
				.then((result) => {
					if (!controller.signal.aborted) setData(result);
				})
				.catch(() => {
					if (!controller.signal.aborted) setData({ error: true });
				});
			return () => controller.abort();
		}, [source, retry]);
		if (data.pending) return note("正在读取文档…");
		if (data.error)
			return h(
				"div",
				null,
				note("此文件暂不能在面板读取，可打开来源消息"),
				button("重试文档", () => setRetry((n) => n + 1)),
			);
		return h(
			"div",
			null,
			data.truncated && note("显示前 64 KiB，完整文件请从来源消息打开"),
			h(
				"pre",
				{
					style: {
						whiteSpace: "pre-wrap",
						overflowWrap: "anywhere",
						font: "inherit",
						margin: 0,
					},
				},
				data.text,
			),
		);
	}
	function Detail({ entry, connection, channelContext, context }) {
		const session = connection.session;
		const channelId = channelContext.channelId;
		const source = entry.attachment ? session.media(entry.url) : undefined;
		const textual =
			entry.attachment &&
			/\.(md|txt|json|[cm]?[jt]sx?|py|rs|html?|css|ya?ml|sh|go|java|sql|csv)$/i.test(
				entry.name,
			);
		const openMessage = () => {
			if (
				!canRead(ctx.relay.snapshot(), channelId) ||
				ctx.relay.snapshot().session !== session
			)
				return;
			const separator = connection.scope.lastIndexOf(":");
			void ctx.navigation.open({
				version: 1,
				kind: "conversation",
				scope: {
					communityOrigin: connection.scope.slice(0, separator),
					viewer: session.viewer,
				},
				channelId,
				messageId: entry.message.id,
			});
		};
		return h(
			"section",
			{
				"aria-label": "产物详情",
				style: { minWidth: 0, overflowWrap: "anywhere" },
			},
			h("h3", null, entry.name),
			h(
				"div",
				{ style: rowStyle },
				button("回到来源消息", openMessage),
				button("打开链接", () => {
					if (context?.canOpen(entry.url)) context.open(entry.url);
					else openMessage();
				}),
			),
			textual && source && h(TextPreview, { key: entry.id, source }),
			h("h4", null, "来源内容"),
			h(
				ctx.conversation.ui.Conversation,
				{
					session,
					scope: connection.scope,
					channelId,
					channelName: channelContext.channelName,
					threadId: entry.message.threadRootId,
				},
				(interactions) =>
					h(ctx.conversation.ui.Message, {
						row: entry.message,
						session,
						scope: connection.scope,
						profile: session.profiles.snapshot().get(entry.message.authorId),
						media: session.media,
						day: false,
						retry: undefined,
						startsThreads: false,
						...interactions,
					}),
			),
		);
	}
	function Board({ connection, channelContext, context }) {
		const [store, setStore] = R.useState();
		R.useEffect(() => {
			const reader = createReader(
				ctx.relay,
				connection,
				channelContext.channelId,
			);
			setStore(reader);
			void reader.start();
			return () => reader.dispose();
		}, [
			connection.session,
			connection.scope,
			connection.generation,
			channelContext.channelId,
		]);
		return store
			? h(BoardView, { connection, channelContext, context, store })
			: note("正在准备产物面板…");
	}
	function BoardView({ connection, channelContext, context, store }) {
		const { session } = connection;
		const data = R.useSyncExternalStore(store.subscribe, store.snapshot);
		const profiles = R.useSyncExternalStore(
			session.profiles.subscribe,
			session.profiles.snapshot,
		);
		const [category, setCategory] = R.useState("all"),
			[scope, setScope] = R.useState("all"),
			[query, setQuery] = R.useState(""),
			[selected, setSelected] = R.useState("");
		const entries = R.useMemo(
			() => artifactsFrom(data.rows, profiles),
			[data.rows, profiles],
		);
		const shown = entries.filter(
			(e) =>
				(category === "all" || category === e.category) &&
				(scope !== "agent" || e.agent) &&
				(scope !== "files" || e.attachment) &&
				e.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
		);
		const entry = entries.find((e) => e.id === selected);
		const reset = () => {
			setCategory("all");
			setScope("all");
			setQuery("");
		};
		return h(
			"section",
			{
				"aria-label": "聊天产物",
				style: {
					display: "flex",
					flexDirection: "column",
					minHeight: 0,
					height: "100%",
					padding: inset,
					gap,
					boxSizing: "border-box",
				},
			},
			h(
				"div",
				{ style: rowStyle },
				h("input", {
					type: "search",
					"aria-label": "搜索本页产物",
					placeholder: "搜索本页产物",
					value: query,
					onChange: (e) => setQuery(e.target.value),
					style: { flex: "1 1 10rem", minWidth: 0, width: "100%" },
				}),
				h(
					"select",
					{
						"aria-label": "产物类型",
						value: category,
						onChange: (e) => setCategory(e.target.value),
					},
					Object.entries(labels).map(([value, label]) =>
						h("option", { key: value, value }, label),
					),
				),
				h(
					"select",
					{
						"aria-label": "产物范围",
						value: scope,
						onChange: (e) => setScope(e.target.value),
					},
					[
						["all", "所有产物"],
						["agent", "Agent 产物"],
						["files", "共享文件"],
					].map(([value, label]) => h("option", { key: value, value }, label)),
				),
				button(
					"刷新",
					() => {
						setSelected("");
						void store.refresh();
					},
					{ disabled: data.pending },
				),
			),
			h(
				"div",
				{ style: rowStyle },
				note(
					`第 ${data.page} 页 · ${data.scanned} 条消息 · ${entries.length} 项产物（含线程回复）`,
				),
				data.changed &&
					button(
						"有新消息，回到最新",
						() => {
							setSelected("");
							void store.refresh();
						},
						{ disabled: data.pending },
					),
			),
			data.error &&
				h(
					"div",
					{ role: "alert" },
					data.error,
					" ",
					button(
						"重试本页",
						() => {
							void store.retry();
						},
						{ disabled: data.pending },
					),
				),
			h(
				"div",
				{
					style: { overflowY: "auto", minHeight: 0, flex: "1 1 auto" },
					"aria-busy": data.pending,
				},
				data.pending && note("正在读取当前聊天的产物…"),
				entry
					? h(
							"div",
							null,
							button("返回产物列表", () => setSelected("")),
							h(Detail, {
								key: entry.id,
								entry,
								connection,
								channelContext,
								context,
							}),
						)
					: h(
							"div",
							{
								style: {
									display: "grid",
									gridTemplateColumns:
										"repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
									gap,
								},
							},
							...shown.map((e) =>
								h(
									"article",
									{
										className: "ui-card",
										key: e.id,
										style: {
											minWidth: 0,
											padding: inset,
											overflowWrap: "anywhere",
										},
									},
									e.category === "image" &&
										h("img", {
											src: session.media(e.url, "small"),
											alt: e.name,
											loading: "lazy",
											style: {
												width: "100%",
												height: "8rem",
												objectFit: "contain",
											},
										}),
									h(
										"p",
										{ style: { color: "var(--text-subtle)" } },
										labels[e.category],
									),
									button(e.name, () => setSelected(e.id), {
										style: {
											maxWidth: "100%",
											whiteSpace: "normal",
											textAlign: "start",
											overflowWrap: "anywhere",
										},
									}),
									h(
										"p",
										{ style: { color: "var(--text-subtle)" } },
										`${profiles.get(e.message.authorId)?.name || e.message.authorId.slice(0, 8)} · ${new Date(e.message.createdAt * 1000).toLocaleDateString()}`,
									),
								),
							),
							!data.pending &&
								!data.error &&
								shown.length === 0 &&
								h(
									"div",
									null,
									note(
										entries.length
											? "本页没有匹配的产物"
											: "本页消息没有产物，可继续查看更早消息",
									),
									button("清除筛选", reset),
								),
						),
			),
			h(
				"div",
				{ style: rowStyle },
				button(
					"上一页",
					() => {
						setSelected("");
						void store.previous();
					},
					{ disabled: data.pending || data.page === 1 },
				),
				button(
					"查看更早消息",
					() => {
						setSelected("");
						void store.next();
					},
					{ disabled: data.pending || !data.more },
				),
				note("仅显示当前已发布消息；搜索作用于本页"),
			),
		);
	}
	function Panel({ target, channelContext, context }) {
		const connection = R.useSyncExternalStore(
			ctx.relay.subscribe,
			ctx.relay.snapshot,
		);
		const channelId = channelContext?.channelId;
		if (
			!channelId ||
			target !== prefix + channelId ||
			connection.scope !== channelContext.scope ||
			connection.session?.viewer !== channelContext.viewer ||
			!canRead(connection, channelId)
		)
			return note("连接并确认当前聊天权限后查看产物");
		return h(Board, {
			key: `${connection.scope}:${connection.generation}:${channelId}`,
			connection,
			channelContext,
			context,
		});
	}
	ctx.panels.register({
		id: "artifacts",
		title: "聊天产物",
		channelPlacement: "tab",
		matches: (target) => target.startsWith(prefix),
		channelLauncher: Launcher,
		component: Panel,
	});
}
