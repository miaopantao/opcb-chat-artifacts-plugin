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

// A local materialized index, never an authority source. The host still folds
// edits/deletions and confirms current channel access before any cache is shown.
export function cacheScope(connection, channelId) {
	return JSON.stringify([
		connection.scope,
		connection.session.viewer,
		channelId,
	]);
}
export function createLocalCache(factory = globalThis.indexedDB) {
	let opening,
		active,
		closed = false;
	const database = () => {
		if (closed) return Promise.reject(new Error("Local cache closed"));
		if (!opening)
			opening = new Promise((resolve, reject) => {
				if (!factory) return reject(new Error("Local cache unavailable"));
				const request = factory.open("opcb.chat-artifacts.cache.v1", 1);
				request.onupgradeneeded = () =>
					request.result.createObjectStore("entries", { keyPath: "key" });
				request.onerror = () => reject(request.error);
				request.onblocked = () => reject(new Error("Local cache locked"));
				request.onsuccess = () => {
					const db = request.result;
					if (closed) {
						db.close();
						reject(new Error("Local cache closed"));
						return;
					}
					active = db;
					db.onversionchange = () => {
						db.close();
						opening = undefined;
					};
					resolve(db);
				};
			});
		return opening;
	};
	const transaction = async (mode, run) => {
		const db = await database();
		return new Promise((resolve, reject) => {
			const tx = db.transaction("entries", mode),
				store = tx.objectStore("entries");
			let result;
			tx.oncomplete = () => resolve(result);
			tx.onabort = tx.onerror = () =>
				reject(tx.error || new Error("Local cache failed"));
			try {
				run(store, (value) => {
					result = value;
				});
			} catch (error) {
				tx.abort();
				reject(error);
			}
		});
	};
	return {
		close() {
			closed = true;
			active?.close();
		},
		async load(scope) {
			return transaction("readonly", (store, done) => {
				const result = { records: [], meta: undefined };
				const rows = store.getAll(
					IDBKeyRange.bound([scope, "row", ""], [scope, "row", "\uffff"]),
				);
				const meta = store.get([scope, "meta", "index"]);
				rows.onsuccess = () => {
					result.records = rows.result.map((item) => item.value);
				};
				meta.onsuccess = () => {
					result.meta = meta.result?.value;
				};
				done(result);
			});
		},
		async commit(scope, records, meta) {
			return transaction("readwrite", (store) => {
				for (const record of records)
					store.put({ key: [scope, "row", record.id], value: record });
				store.put({ key: [scope, "meta", "index"], value: meta });
			});
		},
		async text(scope, source, value) {
			return transaction(
				value === undefined ? "readonly" : "readwrite",
				(store, done) => {
					const key = [scope, "text", source];
					if (value !== undefined) store.put({ key, value });
					else {
						const request = store.get(key);
						request.onsuccess = () => done(request.result?.value);
					}
				},
			);
		},
		async clear(scope) {
			return transaction("readwrite", (store) => {
				store.delete(IDBKeyRange.bound([scope, ""], [scope, "\uffff"]));
			});
		},
	};
}

const CHANGE_KINDS = [9, 40002, 40003, 5, 9005, 39005];
const validId = (id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id);
const sortedEvents = (events) =>
	[...events].sort(
		(a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
	);

export function createReader(
	relay,
	connection,
	channelId,
	pageSize = 12,
	cache = createLocalCache(),
) {
	const { session } = connection,
		partition = cacheScope(connection, channelId);
	let disposed = false,
		revoked = false,
		controller,
		started = false,
		queuedLive = false;
	let meta = {
		initialized: false,
		checkpoint: 0,
		older: undefined,
		more: true,
		pages: 0,
		aliases: {},
	};
	let state = {
		rows: [],
		pending: false,
		more: true,
		error: "",
		cacheError: "",
		scanned: 0,
		changed: false,
		cached: false,
		page: 0,
	};
	const records = new Map(),
		dirty = new Map(),
		watched = new Map(),
		busyViews = new Set(),
		textMemory = new Map(),
		listeners = new Set();
	let writes = Promise.resolve(),
		retryMode = "latest";
	const current = () => {
		const now = relay.snapshot();
		return (
			!disposed &&
			!revoked &&
			now.session === session &&
			now.scope === connection.scope &&
			now.generation === connection.generation &&
			canRead(now, channelId)
		);
	};
	const publish = (patch = {}) => {
		if (disposed) return;
		state = { ...state, ...patch };
		for (const listener of listeners) listener();
	};
	const render = () =>
		publish({
			rows: [...records.values()]
				.flatMap((record) => (record.row ? [record.row] : []))
				.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
			scanned: records.size,
		});
	const closeView = (id) => {
		const owned = watched.get(id);
		if (owned) {
			watched.delete(id);
			owned.stop();
			owned.view.dispose();
		}
	};
	const retire = () => {
		controller?.abort();
		controller = undefined;
		for (const id of [...watched.keys()]) closeView(id);
	};
	const cacheFailed = () => {
		if (current())
			publish({
				cacheError: "本地缓存保存失败，当前列表仍可用；关闭后可能需要重新同步",
			});
	};
	const persist = async () => {
		if (!current()) return;
		const batch = [...dirty.values()];
		dirty.clear();
		const checkpoint = structuredClone(meta);
		writes = writes
			.catch(() => {})
			.then(async () => {
				if (current()) await cache.commit(partition, batch, checkpoint);
			});
		try {
			await writes;
		} catch {
			for (const record of batch)
				if (!dirty.has(record.id)) dirty.set(record.id, record);
			cacheFailed();
		}
	};
	const revoke = () => {
		if (revoked || disposed) return;
		revoked = true;
		retire();
		records.clear();
		dirty.clear();
		textMemory.clear();
		publish({
			rows: [],
			pending: false,
			more: false,
			cached: false,
			error: "连接或阅读权限已变化，请重新打开产物面板",
		});
		// Ordered after any already-started writes, so a late write cannot resurrect it.
		const now = relay.snapshot(),
			channel = now.session?.channels.get?.(channelId);
		const denied =
			now.status === "ready" &&
			now.scope === connection.scope &&
			now.session?.viewer === session.viewer &&
			channel &&
			!channel.cached &&
			!channel.metadataCached &&
			!channel.pending &&
			!channel.metadataPending &&
			channel.visibility === "private" &&
			Array.isArray(channel.members) &&
			!channel.members.includes(session.viewer);
		if (denied)
			writes = writes
				.catch(() => {})
				.then(() => cache.clear(partition))
				.catch(() => {});
	};
	const adopt = (id, view) => {
		if (!current()) return revoke();
		const value = view.snapshot(),
			previous = records.get(id);
		if (value.targetStatus !== "ready" && value.targetStatus !== "unavailable")
			return;
		const row =
			value.targetStatus === "ready" && value.target?.channelId === channelId
				? value.target
				: undefined;
		const record = {
			id,
			time: row?.createdAt ?? previous?.time ?? 0,
			row: row && artifactsFrom([row]).length ? structuredClone(row) : null,
		};
		records.set(id, record);
		dirty.set(id, record);
		render();
		if (!state.pending && started) void persist();
	};
	const resolveIds = async (ids, signal) => {
		const queue = [...new Set(ids.filter(validId))];
		let failures = 0;
		await Promise.all(
			Array.from({ length: Math.min(3, queue.length) }, async () => {
				while (queue.length && current() && !signal.aborted) {
					const id = queue.shift();
					let view;
					busyViews.add(id);
					try {
						let owned = watched.get(id);
						if (!owned) {
							if (watched.size >= 12) {
								const candidate = [...watched.keys()].find(
									(key) => !busyViews.has(key),
								);
								if (candidate) closeView(candidate);
							}
							view = session.thread(channelId, id, { exact: true });
							owned = { view, stop: view.subscribe(() => adopt(id, view)) };
							watched.set(id, owned);
						} else view = owned.view;
						await view.refresh();
						if (!current() || signal.aborted) return;
						adopt(id, view);
						if (
							view.snapshot().targetStatus === "error" ||
							view.snapshot().targetStatus === "loading"
						)
							failures++;
					} catch {
						if (current() && !signal.aborted) failures++;
					} finally {
						busyViews.delete(id);
					}
				}
			}),
		);
		if (failures)
			throw new Error(`${failures} 条消息读取失败，保留已保存内容，请重试同步`);
	};
	const read = async (filter, signal) => {
		const result = await session.readRemote(
			[{ "#h": [channelId], limit: pageSize, ...filter }],
			{ signal, fresh: true },
		);
		if (!current() || signal.aborted)
			throw new DOMException("Stale read", "AbortError");
		const events = sortedEvents([
			...new Map(
				result
					.filter(
						(event) =>
							validId(event.id) &&
							Number.isSafeInteger(event.created_at) &&
							event.created_at >= 0 &&
							event.tags.some(
								([key, value]) => key === "h" && value === channelId,
							) &&
							(filter.kinds || CHANGE_KINDS).includes(event.kind),
					)
					.map((event) => [event.id, event]),
			).values(),
		]);
		if (
			events.length > pageSize ||
			events.some(
				(event) =>
					(filter.since !== undefined && event.created_at < filter.since) ||
					(filter.until !== undefined &&
						(event.created_at > filter.until ||
							(event.created_at === filter.until &&
								event.id <= filter.before_id))),
			)
		)
			throw new Error("历史分页游标不兼容");
		return events;
	};
	const cursor = (event) =>
		event ? { until: event.created_at, before_id: event.id } : undefined;
	async function latest(signal) {
		const since = meta.checkpoint,
			initialized = meta.initialized;
		const boundary = new Set(meta.boundaryIds || []),
			nextBoundary = new Set(boundary);
		let before,
			newest = since,
			first;
		for (;;) {
			const events = await read(
				{
					kinds: initialized ? CHANGE_KINDS : [9, 40002],
					...(initialized ? { since } : {}),
					...(before || {}),
				},
				signal,
			);
			first ??= events;
			const ids = [],
				unknownDeletes = [];
			for (const event of events) {
				if (event.created_at > newest) {
					newest = event.created_at;
					nextBoundary.clear();
				}
				if (event.created_at === newest) nextBoundary.add(event.id);
				if ([9, 40002].includes(event.kind)) {
					if (!records.has(event.id)) ids.push(event.id);
					continue;
				}
				if (event.created_at === since && boundary.has(event.id)) continue;
				const references = event.tags
					.filter(([key, value]) => key === "e" && validId(value))
					.map(([, value]) => value);
				const targets = references.flatMap((id) => meta.aliases[id] || [id]);
				if ([40003, 39005].includes(event.kind))
					meta.aliases[event.id] = targets;
				if (
					[5, 9005].includes(event.kind) &&
					targets.some((id) => !records.has(id))
				)
					unknownDeletes.push(event.id);
				ids.push(...targets);
			}
			// An old overlay can predate this index. Only an unresolvable deletion
			// requires repairing saved artifact rows; ordinary opens never reread them.
			if (unknownDeletes.length)
				ids.push(
					...[...records.values()]
						.filter((item) => item.row)
						.map((item) => item.id),
				);
			await resolveIds(ids, signal);
			if (!initialized || events.length < pageSize) break;
			const next = cursor(events.at(-1));
			if (before?.until === next.until && before?.before_id === next.before_id)
				throw new Error("同步游标没有前进");
			before = next;
		}
		if (!initialized) {
			meta.older = cursor(first.at(-1));
			meta.more = first.length === pageSize;
			meta.pages = 1;
		}
		meta.initialized = true;
		meta.checkpoint = newest;
		meta.boundaryIds = [...nextBoundary];
	}
	async function older(signal) {
		if (!meta.more || !meta.older) return;
		const events = await read({ kinds: [9, 40002], ...meta.older }, signal);
		await resolveIds(
			events.filter((event) => !records.has(event.id)).map((event) => event.id),
			signal,
		);
		if (events.length) meta.older = cursor(events.at(-1));
		meta.more = events.length === pageSize;
		meta.pages++;
	}
	async function sync(mode = "latest") {
		if (!current()) {
			revoke();
			return;
		}
		if (state.pending) {
			if (mode === "latest") queuedLive = true;
			return;
		}
		retryMode = mode;
		const owned = new AbortController();
		controller = owned;
		publish({ pending: true, error: "", changed: false });
		try {
			if (mode === "older") await older(owned.signal);
			else await latest(owned.signal);
			if (!current() || owned.signal.aborted) return;
			await persist();
			if (current())
				publish({ more: meta.more, page: meta.pages, cached: false });
		} catch (error) {
			if (current() && !owned.signal.aborted) {
				await persist();
				publish({ error: `产物读取失败：${error.message || "请重试同步"}` });
			}
		} finally {
			if (controller === owned) controller = undefined;
			if (current()) {
				publish({ pending: false });
				if (queuedLive) {
					queuedLive = false;
					void sync();
				}
			}
		}
	}
	const offChannel = session.channels.subscribeList(() => {
		if (!current()) revoke();
	});
	const offRelay = relay.subscribe(() => {
		if (!current()) revoke();
	});
	const offLive = session.subscribeLive(({ events }) => {
		if (!current()) return;
		if (
			events.some(
				(event) =>
					CHANGE_KINDS.includes(event.kind) &&
					event.tags.some(([key, value]) => key === "h" && value === channelId),
			)
		) {
			publish({ changed: true });
			if (started) void sync();
		}
	});
	return {
		snapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async start() {
			if (started || state.pending) return;
			publish({ pending: true });
			try {
				const saved = await cache.load(partition);
				if (!current()) return;
				if (
					saved?.meta?.initialized &&
					Number.isSafeInteger(saved.meta.checkpoint) &&
					saved.meta.checkpoint >= 0
				) {
					const value = saved.meta;
					if (
						typeof value.more !== "boolean" ||
						!Number.isSafeInteger(value.pages) ||
						value.pages < 0 ||
						(value.older &&
							(!Number.isSafeInteger(value.older.until) ||
								value.older.until < 0 ||
								!validId(value.older.before_id)))
					)
						throw new Error("Invalid local cursor");
					meta = {
						...meta,
						initialized: true,
						checkpoint: value.checkpoint,
						more: value.more,
						pages: value.pages,
						older: value.older,
						boundaryIds: Array.isArray(value.boundaryIds)
							? value.boundaryIds.filter(validId)
							: [],
						aliases: Object.fromEntries(
							Object.entries(value.aliases || {}).filter(
								([id, targets]) =>
									validId(id) &&
									Array.isArray(targets) &&
									targets.every(validId),
							),
						),
					};
					for (const item of Array.isArray(saved.records) ? saved.records : [])
						if (
							validId(item?.id) &&
							(item.row === null ||
								(item.row?.id === item.id &&
									item.row.channelId === channelId &&
									validId(item.row.authorId) &&
									Number.isSafeInteger(item.row.createdAt) &&
									item.row.createdAt >= 0 &&
									typeof item.row.content === "string" &&
									Array.isArray(item.row.attachments) &&
									item.row.attachments.every(
										(attachment) =>
											attachment &&
											typeof attachment.url === "string" &&
											["image", "video", "audio", "file"].includes(
												attachment.kind,
											),
									)))
						)
							records.set(item.id, item);
					render();
					publish({ cached: true, more: meta.more, page: meta.pages });
				}
			} catch {
				cacheFailed();
			} finally {
				if (current()) {
					started = true;
					publish({ pending: false });
				}
			}
			if (current()) await sync();
		},
		retry: () => sync(retryMode),
		refresh: () => sync(),
		next: () => sync("older"),
		async text(source, signal, key = source) {
			if (!current()) throw new Error("阅读权限已变化");
			validateTextSource(source);
			const valid = (value) =>
				value &&
				typeof value.text === "string" &&
				value.text.length <= 65536 &&
				typeof value.truncated === "boolean";
			let value = textMemory.get(key);
			if (!value) {
				try {
					const saved = await cache.text(partition, key);
					if (valid(saved)) value = saved;
				} catch {
					cacheFailed();
				}
			}
			signal.throwIfAborted();
			if (!current()) throw new Error("阅读权限已变化");
			const fetched = !value;
			if (!value) value = await readText(source, signal);
			if (!current() || signal.aborted) throw new Error("阅读权限已变化");
			textMemory.set(key, value);
			if (fetched) {
				writes = writes
					.catch(() => {})
					.then(async () => {
						if (current() && !signal.aborted)
							await cache.text(partition, key, value);
					});
				try {
					await writes;
				} catch {
					cacheFailed();
				}
			}
			if (!current() || signal.aborted) throw new Error("阅读权限已变化");
			return value;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			retire();
			textMemory.clear();
			offChannel();
			offRelay();
			offLive();
			listeners.clear();
		},
	};
}

export function validateTextSource(source) {
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
}

export async function readText(source, signal, request = fetch) {
	validateTextSource(source);
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

// Plugin-owned bookmarks only. Never read other storage keys or message bodies.
// Web Storage can be unavailable; the board keeps working and reports save failure.
export function bookmarkKey(scope, viewer, channelId) {
	return `opcb.chat-artifacts:stars:v1:${JSON.stringify([scope, viewer, channelId])}`;
}
export function readBookmarks(storage, key) {
	try {
		const raw = storage?.getItem(key);
		if (!raw || raw.length > 262144) return [];
		const values = JSON.parse(raw);
		return Array.isArray(values)
			? [
					...new Set(
						values.filter((id) => typeof id === "string" && id.length <= 4096),
					),
				].slice(0, 1000)
			: [];
	} catch {
		return [];
	}
}
export function saveBookmarks(storage, key, ids) {
	try {
		if (!storage || ids.length > 1000) return false;
		const raw = JSON.stringify(ids);
		if (raw.length > 262144) return false;
		storage.setItem(key, raw);
		return true;
	} catch {
		return false;
	}
}

export function apply(ctx) {
	const R = ctx.react,
		h = R.createElement;
	const localCache = createLocalCache();
	ctx.effect?.(() => () => localCache.close());
	const prefix = "opcb:chat-artifacts:";
	const labels = {
		all: "全部",
		website: "网站",
		link: "链接",
		document: "文档",
		image: "图片",
		video: "视频",
		other: "其他",
	};
	const gap = "var(--space-2)";
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
	const selectedStyle = (active) => ({
		background: active ? "var(--surface-inset)" : "transparent",
		color: active ? "var(--text-standard)" : "var(--text-subtle)",
		border: "1px solid transparent",
		borderRadius: "var(--radius-control, 8px)",
		minHeight: 32,
		padding: "4px 8px",
	});
	function Icon({ type, size = 20 }) {
		const paths = {
			grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
			list: "M8 5h13 M8 12h13 M8 19h13 M3 5h.01 M3 12h.01 M3 19h.01",
			star: "m12 2 3 6.4 7 .9-5.1 5 1.3 7L12 18l-6.2 3.3 1.3-7L2 9.3l7-.9Z",
			more: "M4 12h.01 M12 12h.01 M20 12h.01",
			external: "M14 3h7v7 M21 3l-12 12 M10 3H3v18h18v-7",
			image: "M3 3h18v18H3z M3 17l6-6 4 4 3-3 5 5 M7 7h.01",
			video: "M3 5h12v14H3z M15 10l6-4v12l-6-4",
			document: "M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8",
			website:
				"M2 12h20 M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20 M12 2c6 6 6 14 0 20-6-6-6-14 0-20",
			link: "m10 14 4-4 M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
			other: "M5 2h9l5 5v15H5z M14 2v6h5",
		};
		return h(
			"svg",
			{
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
				style: { flexShrink: 0 },
			},
			h("path", { d: paths[type] || paths.other }),
		);
	}
	function useWidth() {
		const ref = R.useRef(null),
			[width, setWidth] = R.useState(0);
		R.useEffect(() => {
			const node = ref.current;
			if (!node) return;
			const measure = () => setWidth(node.getBoundingClientRect().width);
			measure();
			const observer = new ResizeObserver(measure);
			observer.observe(node);
			return () => observer.disconnect();
		}, []);
		return [ref, width];
	}
	function Preview({ entry, session, store }) {
		const ref = R.useRef(null),
			[visible, setVisible] = R.useState(false);
		const [failedSource, setFailedSource] = R.useState("");
		R.useEffect(() => {
			const observer = new IntersectionObserver(
				([item]) => {
					if (item?.isIntersecting) {
						setVisible(true);
						observer.disconnect();
					}
				},
				{ rootMargin: "120px" },
			);
			if (ref.current) observer.observe(ref.current);
			return () => observer.disconnect();
		}, []);
		const thumbnail =
			entry.category === "image"
				? session.media(entry.attachment?.previewUrl || entry.url, "small")
				: entry.attachment?.previewUrl
					? session.media(entry.attachment.previewUrl)
					: undefined;
		const textual =
			entry.attachment &&
			/\.(md|markdown|txt|json|[cm]?[jt]sx?|py|rs|html?|css|ya?ml|sh|go|java|sql|csv)$/i.test(
				entry.name,
			);
		return h(
			"div",
			{
				ref,
				style: {
					height: "14rem",
					width: "100%",
					position: "relative",
					overflow: "hidden",
					textAlign: "start",
					background: "var(--surface-inset)",
					borderTop: "1px solid var(--border-primary)",
					borderRadius:
						"0 0 var(--radius-control, 8px) var(--radius-control, 8px)",
					pointerEvents: "none",
				},
			},
			visible && thumbnail && thumbnail !== failedSource
				? h("img", {
						src: thumbnail,
						alt: "",
						loading: "lazy",
						decoding: "async",
						onError: () => setFailedSource(thumbnail),
						style: {
							width: "100%",
							height: "100%",
							objectFit: "cover",
							objectPosition: "top",
							display: "block",
						},
					})
				: visible && textual
					? h(
							"div",
							{
								style: {
									padding: "var(--space-4, 16px)",
									overflowWrap: "anywhere",
								},
							},
							h(TextPreview, {
								source: session.media(entry.url),
								cacheKey: entry.url,
								store,
								name: entry.name,
								compact: true,
							}),
						)
					: h(
							"div",
							{
								style: {
									height: "100%",
									display: "flex",
									flexDirection: "column",
									alignItems: "center",
									justifyContent: "center",
									padding: 16,
									gap: 12,
									textAlign: "center",
									color: "var(--text-subtle)",
									overflowWrap: "anywhere",
								},
							},
							h(Icon, { type: entry.category, size: 32 }),
							h("span", null, entry.name),
							!entry.attachment &&
								h(
									"span",
									{ style: { fontSize: "0.875em" } },
									new URL(entry.url).hostname,
								),
						),
			entry.category === "video" &&
				h(
					"span",
					{
						style: {
							position: "absolute",
							top: "50%",
							left: "50%",
							transform: "translate(-50%, -50%)",
							padding: "8px 16px",
							borderRadius: "var(--radius-pill, 24px)",
							background: "var(--surface-inverse)",
							color: "var(--text-inverse)",
						},
					},
					"播放",
				),
		);
	}
	function ItemActions({ item, starred, star, openMessage }) {
		return h(
			"details",
			{
				style: { position: "relative", flexShrink: 0 },
				onBlur: (event) => {
					if (!event.currentTarget.contains(event.relatedTarget))
						event.currentTarget.open = false;
				},
				onKeyDown: (event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.currentTarget.open = false;
						event.currentTarget.querySelector("summary").focus();
					}
				},
			},
			h(
				"summary",
				{
					"aria-label": `${item.name} 操作`,
					title: `${item.name} 操作`,
					style: {
						...selectedStyle(false),
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						cursor: "pointer",
						listStyle: "none",
					},
				},
				h(Icon, { type: "more" }),
			),
			h(
				"div",
				{
					style: {
						position: "absolute",
						right: 0,
						top: "100%",
						zIndex: 3,
						background: "var(--surface-panel)",
						border: "1px solid var(--border-primary)",
						borderRadius: "var(--radius-control, 8px)",
						padding: 4,
						minWidth: "10rem",
						display: "flex",
						flexDirection: "column",
					},
				},
				button(
					starred ? "取消收藏" : "收藏",
					(event) => {
						star(item);
						event.currentTarget.closest("details").open = false;
					},
					{ style: { ...selectedStyle(false), textAlign: "start" } },
				),
				button(
					"回到原消息",
					(event) => {
						openMessage(item);
						event.currentTarget.closest("details").open = false;
					},
					{ style: { ...selectedStyle(false), textAlign: "start" } },
				),
			),
		);
	}
	function Launcher({ context, available, pressed, toggle }) {
		return button(
			"产物",
			() => {
				if (available()) toggle(prefix + context.channelId);
			},
			{ "aria-label": "聊天产物", "aria-expanded": pressed, title: "聊天产物" },
		);
	}
	function Markdown({ text }) {
		// Bounded, inert document presentation: no HTML, image loads or active links.
		const inline = (value) =>
			value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
				part.startsWith("**")
					? h("strong", { key: i }, part.slice(2, -2))
					: part.startsWith("`")
						? h(
								"code",
								{
									key: i,
									style: {
										background: "var(--surface-inset)",
										padding: "0 4px",
									},
								},
								part.slice(1, -1),
							)
						: part,
			);
		const nodes = [],
			lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i],
				heading = /^(#{1,6})\s+(.+)$/.exec(line);
			if (/^\s*```/.test(line)) {
				const code = [];
				while (++i < lines.length && !/^\s*```/.test(lines[i]))
					code.push(lines[i]);
				nodes.push(
					h(
						"pre",
						{
							key: i,
							style: {
								margin: "12px 0",
								padding: 16,
								background: "var(--surface-inset)",
								overflowX: "auto",
								whiteSpace: "pre-wrap",
								fontSize: "0.875em",
							},
						},
						code.join("\n"),
					),
				);
			} else if (heading) {
				nodes.push(
					h(
						`h${heading[1].length}`,
						{
							key: i,
							style: {
								margin: "20px 0 12px",
								fontSize:
									heading[1].length === 1
										? "1.5em"
										: heading[1].length === 2
											? "1.25em"
											: "1em",
								fontWeight: 600,
								paddingBottom: 8,
								borderBottom:
									heading[1].length <= 2
										? "1px solid var(--border-primary)"
										: undefined,
							},
						},
						inline(heading[2]),
					),
				);
			} else if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
				const ordered = /^\s*\d+\./.test(line),
					items = [],
					pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
				do {
					items.push(
						h(
							"li",
							{ key: i, style: { margin: "4px 0" } },
							inline(lines[i].replace(pattern, "")),
						),
					);
					i++;
				} while (i < lines.length && pattern.test(lines[i]));
				i--;
				nodes.push(
					h(
						ordered ? "ol" : "ul",
						{
							key: `list-${i}`,
							style: { margin: "12px 0", paddingInlineStart: 24 },
						},
						...items,
					),
				);
			} else if (line.trim())
				nodes.push(
					h("p", { key: i, style: { margin: "12px 0" } }, inline(line)),
				);
		}
		return h(
			"div",
			{
				style: {
					maxWidth: "52rem",
					marginInline: "auto",
					lineHeight: 1.6,
					overflowWrap: "anywhere",
				},
			},
			...nodes,
		);
	}
	function TextPreview({
		source,
		name = "",
		compact = false,
		store,
		cacheKey,
	}) {
		const [data, setData] = R.useState({ pending: true });
		const [retry, setRetry] = R.useState(0);
		R.useEffect(() => {
			const controller = new AbortController();
			setData({ pending: true });
			store
				.text(source, controller.signal, cacheKey)
				.then((result) => {
					if (!controller.signal.aborted) setData(result);
				})
				.catch(() => {
					if (!controller.signal.aborted) setData({ error: true });
				});
			return () => controller.abort();
		}, [source, retry, store, cacheKey]);
		if (data.pending) return note("正在读取文档…");
		if (data.error && compact) return note("打开查看文档或来源消息");
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
			!compact &&
				data.truncated &&
				note("显示前 64 KiB，完整文件请从来源消息打开"),
			/\.(md|markdown)$/i.test(name)
				? h(Markdown, { text: data.text })
				: h(
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
	function Detail({ entry, connection, channelContext, context, store }) {
		const session = connection.session;
		const channelId = channelContext.channelId;
		const source = entry.attachment ? session.media(entry.url) : undefined;
		const textual =
			entry.attachment &&
			/\.(md|markdown|txt|json|[cm]?[jt]sx?|py|rs|html?|css|ya?ml|sh|go|java|sql|csv)$/i.test(
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
			textual &&
				source &&
				h(TextPreview, {
					key: entry.id,
					source,
					name: entry.name,
					store,
					cacheKey: entry.url,
				}),
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
				12,
				localCache,
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
			[scope, setScope] = R.useState("agent"),
			[query, setQuery] = R.useState(""),
			[layout, setLayout] = R.useState("grid"),
			[starredOnly, setStarredOnly] = R.useState(false),
			[selected, setSelected] = R.useState("");
		const [root, width] = useWidth();
		const scroller = R.useRef(null),
			lastScroll = R.useRef(0),
			lastTrigger = R.useRef(null);
		const inspect = (item, event) => {
			lastScroll.current = scroller.current?.scrollTop || 0;
			lastTrigger.current = event.currentTarget;
			setSelected(item.id);
		};
		R.useLayoutEffect(() => {
			if (scroller.current)
				scroller.current.scrollTop = selected ? 0 : lastScroll.current;
			if (!selected && lastTrigger.current?.isConnected)
				lastTrigger.current.focus({ preventScroll: true });
		}, [selected]);
		const storageKey = bookmarkKey(
			connection.scope,
			session.viewer,
			channelContext.channelId,
		);
		const storage = () => {
			try {
				return globalThis.localStorage;
			} catch {
				return undefined;
			}
		};
		const [stars, setStars] = R.useState(() =>
			readBookmarks(storage(), storageKey),
		);
		const [saveError, setSaveError] = R.useState(false);
		const entries = R.useMemo(
			() => artifactsFrom(data.rows, profiles),
			[data.rows, profiles],
		);
		const shown = entries.filter(
			(e) =>
				(category === "all" || category === e.category) &&
				(scope !== "agent" || e.agent) &&
				(scope !== "files" || e.attachment) &&
				(!starredOnly || stars.includes(e.id)) &&
				e.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
		);
		const entry = entries.find((e) => e.id === selected);
		const reset = () => {
			setCategory("all");
			setStarredOnly(false);
			setQuery("");
		};
		const star = (item) => {
			const next = stars.includes(item.id)
				? stars.filter((id) => id !== item.id)
				: [...stars, item.id];
			setStars(next);
			setSaveError(!saveBookmarks(storage(), storageKey, next));
		};
		const openMessage = (item) => {
			const current = ctx.relay.snapshot();
			if (
				!canRead(current, channelContext.channelId) ||
				current.session !== session
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
				channelId: channelContext.channelId,
				messageId: item.message.id,
			});
		};
		const pageAction = (method) => {
			setSelected("");
			void store[method]();
		};
		const fieldStyle = {
			...rowStyle,
			border: 0,
			margin: 0,
			padding: 0,
			gap: "var(--space-1, 4px)",
		};
		const collectionId = R.useId();
		const collections = [
			["agent", "Agent 产物"],
			["files", "已分享文件"],
			["all", "全部文件"],
		];
		const scopeTabs = collections.map(([value, label], index) =>
			button(
				label,
				() => {
					setScope(value);
					setSelected("");
				},
				{
					key: value,
					id: `${collectionId}-${value}`,
					role: "tab",
					"aria-selected": scope === value,
					"aria-controls": `${collectionId}-content`,
					tabIndex: scope === value ? 0 : -1,
					onKeyDown: (event) => {
						if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
							return;
						event.preventDefault();
						const next =
							event.key === "Home"
								? 0
								: event.key === "End"
									? collections.length - 1
									: (index +
											(event.key === "ArrowRight" ? 1 : -1) +
											collections.length) %
										collections.length;
						setScope(collections[next][0]);
						setSelected("");
						event.currentTarget.parentElement
							.querySelectorAll('[role="tab"]')
							[next].focus();
					},
					style: {
						...selectedStyle(scope === value),
						whiteSpace: "nowrap",
						borderRadius: 0,
						borderBottom:
							scope === value
								? "2px solid var(--text-standard)"
								: "2px solid transparent",
						padding: "12px 8px",
						background: "transparent",
					},
				},
			),
		);
		const controls = h(
			"div",
			{
				style: {
					...rowStyle,
					justifyContent: "space-between",
					gap: 12,
					padding: width <= 576 ? "16px 12px" : "16px 20px",
				},
			},
			h(
				"fieldset",
				{ "aria-label": "产物类型", style: fieldStyle },
				...Object.entries(labels).map(([value, label]) =>
					button(label, () => setCategory(value), {
						key: value,
						"aria-pressed": category === value,
						style: selectedStyle(category === value),
					}),
				),
			),
			h(
				"div",
				{
					style: {
						...rowStyle,
						gap: 12,
						width: width <= 1040 ? "100%" : undefined,
					},
				},
				h("input", {
					type: "search",
					"aria-label": "搜索已加载产物",
					placeholder: "搜索文件名",
					value: query,
					onChange: (e) => setQuery(e.target.value),
					style: {
						width: "15rem",
						maxWidth: "100%",
						minWidth: "min(100%, 8rem)",
						flex: width <= 1040 ? "1 1 8rem" : undefined,
					},
				}),
				button(h(Icon, { type: "star" }), () => setStarredOnly(!starredOnly), {
					"aria-label": "仅看收藏",
					title: "仅看收藏",
					"aria-pressed": starredOnly,
					style: {
						...selectedStyle(starredOnly),
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					},
				}),
				h(
					"fieldset",
					{
						"aria-label": "显示方式",
						style: {
							...fieldStyle,
							background: "var(--surface-inset)",
							borderRadius: "var(--radius-control, 8px)",
							flexWrap: "nowrap",
						},
					},
					...[
						["grid", "卡片视图"],
						["list", "列表视图"],
					].map(([value, label]) =>
						button(h(Icon, { type: value }), () => setLayout(value), {
							key: value,
							"aria-label": label,
							title: label,
							"aria-pressed": layout === value,
							style: {
								...selectedStyle(layout === value),
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
							},
						}),
					),
				),
				button("刷新", () => pageAction("refresh"), {
					disabled: data.pending,
					style: selectedStyle(false),
				}),
			),
		);
		return h(
			"section",
			{
				ref: root,
				"aria-label": "产物看板",
				style: {
					display: "flex",
					flexDirection: "column",
					minWidth: 0,
					minHeight: 0,
					height: "100%",
					color: "var(--text-standard)",
					boxSizing: "border-box",
				},
			},
			h(
				"div",
				{
					role: "tablist",
					"aria-label": "产物范围",
					style: {
						...rowStyle,
						flexWrap: "nowrap",
						padding: "0 12px",
						borderBottom: "1px solid var(--border-primary)",
						overflowX: "auto",
						flexShrink: 0,
					},
				},
				...scopeTabs,
			),
			h(
				"div",
				{
					id: `${collectionId}-content`,
					role: "tabpanel",
					"aria-labelledby": `${collectionId}-${scope}`,
					style: {
						display: "flex",
						flexDirection: "column",
						minHeight: 0,
						flex: 1,
					},
				},
				controls,
				h(
					"div",
					{
						style: {
							...rowStyle,
							justifyContent: "space-between",
							padding: "0 20px 12px",
							color: "var(--text-subtle)",
							fontSize: "0.875em",
						},
					},
					h(
						"span",
						{ role: "status" },
						`已加载 ${entries.length} 项产物 · 筛选显示 ${shown.length} 项${data.cached ? " · 本地缓存" : ""}${data.pending ? " · 正在同步" : ""}`,
					),
					data.changed &&
						button("同步最新产物", () => pageAction("refresh"), {
							disabled: data.pending,
						}),
				),
				data.error &&
					h(
						"div",
						{ role: "alert", style: { padding: "8px 20px" } },
						data.error,
						" ",
						button("重试同步", () => pageAction("retry"), {
							disabled: data.pending,
						}),
					),
				saveError &&
					h(
						"p",
						{ role: "alert", style: { paddingInline: 20 } },
						"收藏未能保存到本机",
					),
				data.cacheError &&
					h(
						"p",
						{ role: "alert", style: { paddingInline: 20 } },
						data.cacheError,
					),
				h(
					"div",
					{
						ref: scroller,
						"aria-busy": data.pending,
						style: {
							overflowY: "auto",
							minHeight: 0,
							flex: "1 1 auto",
							padding: width <= 576 ? "0 12px 20px" : "0 20px 20px",
						},
					},
					data.pending && note("正在读取当前聊天的产物…"),
					entry &&
						h(
							"div",
							null,
							button("返回产物列表", () => setSelected("")),
							h(Detail, {
								key: entry.id,
								entry,
								connection,
								channelContext,
								context,
								store,
							}),
						),
					h(
						"ul",
						{
							"aria-label": "产物列表",
							hidden: !!entry,
							style: {
								margin: 0,
								padding: 0,
								listStyle: "none",
								display: entry ? "none" : "grid",
								gap: 16,
								gridTemplateColumns:
									layout === "list"
										? "minmax(0, 1fr)"
										: `repeat(${width > 1040 ? 3 : width > 576 ? 2 : 1}, minmax(0, 1fr))`,
							},
						},
						...shown.map((item) =>
							h(
								"li",
								{
									key: item.id,
									style: {
										minWidth: 0,
										border: "1px solid var(--border-primary)",
										borderRadius: "var(--radius-control, 8px)",
										background: "var(--surface-panel)",
									},
								},
								h(
									"div",
									{
										style: {
											display: "flex",
											alignItems: "center",
											gap: 8,
											padding: 12,
											minWidth: 0,
										},
									},
									h(Icon, { type: item.category }),
									button(
										h(
											"span",
											{
												style: {
													display: "block",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												},
											},
											item.name,
										),
										(event) => inspect(item, event),
										{
											title: item.name,
											style: {
												...selectedStyle(false),
												color: "var(--text-standard)",
												textAlign: "start",
												flex: 1,
												minWidth: 0,
												overflow: "hidden",
												padding: 0,
											},
										},
									),
									h(ItemActions, {
										item,
										starred: stars.includes(item.id),
										star,
										openMessage,
									}),
								),
								layout === "grid" &&
									button(
										h(Preview, { entry: item, session, store }),
										(event) => inspect(item, event),
										{
											"aria-label": `查看 ${item.name}`,
											style: {
												display: "block",
												width: "100%",
												border: 0,
												padding: 0,
												borderRadius:
													"0 0 var(--radius-control, 8px) var(--radius-control, 8px)",
												background: "transparent",
												textAlign: "start",
											},
										},
									),
							),
						),
						!data.pending &&
							!data.error &&
							shown.length === 0 &&
							h(
								"li",
								{
									style: {
										gridColumn: "1 / -1",
										display: "flex",
										flexDirection: "column",
										alignItems: "center",
										justifyContent: "center",
										minHeight: "14rem",
										gap: 12,
										color: "var(--text-subtle)",
									},
								},
								h(Icon, { type: "grid", size: 24 }),
								note(entries.length ? "没有匹配的产物" : "本页暂无产物"),
								(query || category !== "all" || starredOnly) &&
									button("清除筛选", reset),
							),
					),
					h(
						"div",
						{
							style: {
								...rowStyle,
								justifyContent: "center",
								padding: "16px 0",
							},
						},
						button("加载更早产物", () => pageAction("next"), {
							disabled: data.pending || !data.more,
						}),
					),
					h(
						"p",
						{
							style: {
								margin: "0",
								color: "var(--text-subtle)",
								fontSize: "0.875em",
								textAlign: "center",
							},
						},
						"包含线程回复 · 新旧产物累计保留 · 搜索覆盖已加载产物",
					),
				),
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
