import assert from "node:assert/strict";
import { test } from "node:test";
import {
	apply,
	artifactsFrom,
	bookmarkKey,
	cacheScope,
	canRead,
	inject,
	linksIn,
	createReader as openReader,
	readBookmarks,
	readText,
	safeUrl,
	saveBookmarks,
} from "../plugin.js";

function memoryCache() {
	const partitions = new Map(),
		texts = new Map();
	const state = (scope) => {
		if (!partitions.has(scope))
			partitions.set(scope, { records: new Map(), meta: undefined });
		return partitions.get(scope);
	};
	return {
		partitions,
		async load(scope) {
			const saved = state(scope);
			return structuredClone({
				records: [...saved.records.values()],
				meta: saved.meta,
			});
		},
		async commit(scope, records, meta) {
			const saved = state(scope);
			for (const record of records)
				saved.records.set(record.id, structuredClone(record));
			saved.meta = structuredClone(meta);
		},
		async text(scope, source, value) {
			const key = JSON.stringify([scope, source]);
			if (value !== undefined) texts.set(key, structuredClone(value));
			return structuredClone(texts.get(key));
		},
		async clear(scope) {
			partitions.delete(scope);
			for (const key of texts.keys())
				if (JSON.parse(key)[0] === scope) texts.delete(key);
		},
	};
}
const createReader = (
	relay,
	connection,
	channel,
	pageSize = 12,
	cache = memoryCache(),
) => openReader(relay, connection, channel, pageSize, cache);
const until = async (condition) => {
	for (let i = 0; i < 100; i++) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail("expected async state was not reached");
};

test("bookmarks are isolated by community, account and channel and survive reload", () => {
	const values = new Map(),
		storage = {
			getItem: (key) => values.get(key),
			setItem: (key, value) => values.set(key, value),
		};
	const key = bookmarkKey("community-a", "viewer-a", "channel-a");
	assert.equal(saveBookmarks(storage, key, ["message:artifact"]), true);
	assert.deepEqual(readBookmarks(storage, key), ["message:artifact"]);
	for (const other of [
		bookmarkKey("community-b", "viewer-a", "channel-a"),
		bookmarkKey("community-a", "viewer-b", "channel-a"),
		bookmarkKey("community-a", "viewer-a", "channel-b"),
	])
		assert.deepEqual(readBookmarks(storage, other), []);
	assert.deepEqual([...values.keys()], [key]);
});

test("corrupt or unavailable bookmark storage never breaks the collection", () => {
	assert.deepEqual(
		readBookmarks({ getItem: () => "broken JSON" }, "own-key"),
		[],
	);
	assert.deepEqual(
		readBookmarks({ getItem: () => '[null,42,"one","one"]' }, "own-key"),
		["one"],
	);
	assert.equal(saveBookmarks(undefined, "own-key", []), false);
	assert.equal(
		saveBookmarks(
			{
				setItem() {
					throw new Error("quota");
				},
			},
			"own-key",
			[],
		),
		false,
	);
	assert.equal(
		saveBookmarks(
			{
				setItem() {
					assert.fail("oversize writes must not happen");
				},
			},
			"own-key",
			Array(1001).fill("one"),
		),
		false,
	);
});

const id = (n) => n.toString(16).padStart(64, "0");
const channelId = "00000000-0000-4000-8000-000000000001";
const row = (n, patch = {}) => ({
	id: id(n),
	channelId,
	authorId: id(99),
	createdAt: 100,
	content: "",
	attachments: [],
	...patch,
});
const event = (n, time = 100) => ({
	id: id(n),
	kind: 9,
	created_at: time,
	tags: [["h", channelId]],
	content: "raw body must never render",
});
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

test("Buzz angle-wrapped Markdown URLs and autolinks remain discoverable", () => {
	assert.deepEqual(
		linksIn("[交付](<https://example.com/a>)\n<https://example.com/b>"),
		[
			{ name: "交付", url: "https://example.com/a" },
			{ url: "https://example.com/b" },
		],
	);
});
function fixture(read = async () => [event(1), event(2)]) {
	const channelListeners = new Set(),
		relayListeners = new Set(),
		live = new Set();
	const views = [],
		requests = [];
	let channel = { id: channelId, visibility: "private", members: [id(99)] };
	const session = {
		viewer: id(99),
		channels: {
			get: () => channel,
			list: () => ({ channels: [channel] }),
			subscribeList: (f) => {
				channelListeners.add(f);
				return () => channelListeners.delete(f);
			},
		},
		readRemote: async (...args) => {
			requests.push(args);
			return read(...args);
		},
		subscribeLive: (f) => {
			live.add(f);
			return () => live.delete(f);
		},
		thread: (_channel, messageId, options) => {
			assert.equal(_channel, channelId);
			assert.deepEqual(options, { exact: true });
			const listeners = new Set();
			let snapshot = { targetStatus: "loading" };
			const view = {
				disposed: false,
				snapshot: () => snapshot,
				subscribe(f) {
					listeners.add(f);
					return () => listeners.delete(f);
				},
				update(next) {
					snapshot = next;
					for (const f of listeners) f();
				},
				async refresh() {
					view.update({
						targetStatus: "ready",
						target: row(Number.parseInt(messageId, 16), {
							content: "host-folded edited content https://example.com/result",
						}),
					});
				},
				dispose() {
					this.disposed = true;
					assert.equal(listeners.size, 0);
				},
			};
			views.push(view);
			return view;
		},
	};
	const connection = {
		status: "ready",
		scope: `https://relay.example:${id(99)}`,
		generation: 1,
		session,
	};
	let current = connection;
	const relay = {
		snapshot: () => current,
		subscribe(f) {
			relayListeners.add(f);
			return () => relayListeners.delete(f);
		},
	};
	return {
		connection,
		relay,
		session,
		views,
		requests,
		revoke() {
			channel = { ...channel, members: [] };
			for (const f of channelListeners) f();
		},
		reconnect() {
			current = { ...connection, generation: 2, session: { ...session } };
			for (const f of relayListeners) f();
		},
		emit(events) {
			for (const f of live) f({ events });
		},
		owned: () => channelListeners.size + relayListeners.size + live.size,
	};
}

test("attachments are deduplicated; unsafe URLs and example code do not become artifacts", () => {
	const rows = [
		row(1, {
			agentEnvelope: true,
			content:
				"[File](https://example.com/a.pdf)\n`https://code.test/`\n```js\nhttps://example.test/\n```\nhttps://website.test/",
			attachments: [
				{ kind: "file", name: "a.pdf", url: "https://example.com/a.pdf" },
				{ kind: "image", url: "javascript:alert(1)" },
			],
		}),
	];
	const entries = artifactsFrom(rows);
	assert.deepEqual(
		entries.map((e) => [e.url, e.category, e.agent]),
		[
			["https://example.com/a.pdf", "document", true],
			["https://website.test/", "website", true],
		],
	);
	for (const url of [
		"file:///etc/passwd",
		"data:text/html,<script>",
		"https://name:secret@example.com",
		"javascript:alert(1)",
	])
		assert.equal(safeUrl(url), undefined);
});

test("unconfirmed membership or metadata cannot grant read access", () => {
	const f = fixture();
	assert.equal(canRead(f.connection, channelId), true);
	for (const flag of [
		"cached",
		"metadataCached",
		"pending",
		"metadataPending",
	]) {
		const original = f.session.channels.get;
		f.session.channels.get = () => ({ ...original(), [flag]: true });
		assert.equal(canRead(f.connection, channelId), false);
		f.session.channels.get = original;
	}
	assert.equal(canRead({ ...f.connection, cached: true }, channelId), false);
	f.revoke();
	assert.equal(canRead(f.connection, channelId), false);
});

test("only the host's folded exact target is shown, including replies and live deletion", async () => {
	const f = fixture(),
		reader = createReader(f.relay, f.connection, channelId);
	await reader.start();
	assert.equal(
		reader.snapshot().rows[0].content,
		"host-folded edited content https://example.com/result",
	);
	f.views[0].update({
		targetStatus: "ready",
		target: row(1, {
			threadRootId: id(8),
			content: "reply https://example.com/result",
		}),
	});
	assert.equal(reader.snapshot().rows[0].threadRootId, id(8));
	f.views[0].update({ targetStatus: "unavailable", target: undefined });
	assert.deepEqual(
		reader.snapshot().rows.map((r) => r.id),
		[id(2)],
	);
	reader.dispose();
	assert.equal(f.owned(), 0);
	assert.ok(f.views.every((v) => v.disposed));
});

test("same-second pages use the relay cursor, not the folded/display rows", async () => {
	const f = fixture(async ([filter]) =>
		filter.before_id ? [event(3)] : [event(1), event(2)],
	);
	const reader = createReader(f.relay, f.connection, channelId, 2);
	await reader.start();
	f.views[1].update({ targetStatus: "unavailable" });
	await reader.next();
	assert.deepEqual(f.requests[1][0][0], {
		kinds: [9, 40002],
		"#h": [channelId],
		limit: 2,
		until: 100,
		before_id: id(2),
	});
	assert.equal(reader.snapshot().page, 2);
	assert.equal(reader.snapshot().more, false);
	assert.deepEqual(
		reader.snapshot().rows.map((r) => r.id),
		[id(1), id(3)],
	);
	assert.equal(f.requests.length, 2);
	reader.dispose();
});

test("retry after an older-page failure repeats the failed cursor", async () => {
	let fail = true;
	const f = fixture(async ([filter]) => {
		if (!filter.before_id) return [event(1), event(2)];
		if (fail) throw new Error("offline");
		return [event(3)];
	});
	const reader = createReader(f.relay, f.connection, channelId, 2);
	await reader.start();
	await reader.next();
	assert.match(reader.snapshot().error, /读取失败/);
	fail = false;
	await reader.retry();
	assert.equal(reader.snapshot().page, 2);
	assert.equal(f.requests[2][0][0].before_id, id(2));
	reader.dispose();
});

test("revocation cancels reads and fences a late response that ignores abort", async () => {
	const gate = deferred(),
		f = fixture(() => gate.promise),
		reader = createReader(f.relay, f.connection, channelId);
	const started = reader.start();
	await until(() => f.requests.length > 0);
	f.revoke();
	assert.equal(f.requests[0][1].signal.aborted, true);
	gate.resolve([event(1)]);
	await started;
	assert.equal(f.views.length, 0);
	assert.deepEqual(reader.snapshot().rows, []);
	assert.match(reader.snapshot().error, /权限/);
	reader.dispose();
});

test("a new session retires current views and cannot retain private results", async () => {
	const f = fixture(),
		reader = createReader(f.relay, f.connection, channelId);
	await reader.start();
	f.reconnect();
	assert.deepEqual(reader.snapshot().rows, []);
	assert.ok(f.views.every((v) => v.disposed));
	reader.dispose();
});

test("failed discovery can retry; live events sync incrementally without replacing saved rows", async () => {
	let fail = true;
	let newest = false;
	const f = fixture(async () => {
		if (fail) throw new Error("offline");
		return newest ? [event(9, 101)] : [event(1)];
	});
	const reader = createReader(f.relay, f.connection, channelId);
	await reader.start();
	assert.match(reader.snapshot().error, /读取失败/);
	fail = false;
	await reader.retry();
	assert.equal(reader.snapshot().rows.length, 1);
	newest = true;
	f.emit([event(9, 101)]);
	await until(() => !reader.snapshot().pending);
	assert.deepEqual(
		reader.snapshot().rows.map((r) => r.id),
		[id(1), id(9)],
	);
	assert.equal(f.requests.length, 3);
	assert.equal(f.requests[2][0][0].since, 100);
	reader.dispose();
});

test("partial exact-reader failure is visible and does not fall back to original wire text", async () => {
	const f = fixture();
	const original = f.session.thread;
	f.session.thread = (...args) => {
		const view = original(...args);
		view.refresh = async () => view.update({ targetStatus: "error" });
		return view;
	};
	const reader = createReader(f.relay, f.connection, channelId);
	await reader.start();
	assert.equal(reader.snapshot().rows.length, 0);
	assert.match(reader.snapshot().error, /2 条消息读取失败/);
	reader.dispose();
});

test("text previews only read canonical host media URLs and are bounded/cancellable", async () => {
	let called = false;
	for (const source of [
		"https://example.com/private",
		"file:///etc/passwd",
		"buzz-media://other/arbitrary",
		"http://buzz-media.localhost/anything",
		"http://buzz-media.localhost/https%3A%2F%2Fexample.com%2Fsecret",
	]) {
		await assert.rejects(
			readText(source, new AbortController().signal, async () => {
				called = true;
			}),
		);
	}
	assert.equal(called, false);
	const media = `https://relay.example/media/${id(1)}.md`;
	const source = `http://buzz-media.localhost/${encodeURIComponent(media)}`;
	let cancelled = false;
	const response = () =>
		Promise.resolve({
			ok: true,
			body: new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(70000).fill(65));
				},
				cancel() {
					cancelled = true;
				},
			}),
		});
	const result = await readText(source, new AbortController().signal, response);
	assert.equal(result.text.length, 65536);
	assert.equal(result.truncated, true);
	assert.equal(cancelled, true);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(readText(source, controller.signal, response));
});

test("plugin activation registers only a scoped channel panel, with no host process/network grants", () => {
	const panels = [];
	apply({
		react: { createElement() {} },
		panels: { register: (panel) => panels.push(panel) },
	});
	assert.deepEqual(inject, [
		"react",
		"panels",
		"relay",
		"conversation",
		"navigation",
	]);
	assert.equal(panels.length, 1);
	assert.equal(panels[0].channelPlacement, "tab");
	assert.equal(panels[0].matches("opcb:chat-artifacts:channel"), true);
	assert.equal(panels[0].matches("https://example.com"), false);
});

test("older loads append instead of replacing, and failed sync never blanks saved artifacts", async () => {
	let offline = false;
	const f = fixture(async ([filter]) => {
		if (offline) throw Error("offline");
		return filter.before_id ? [event(3, 99)] : [event(1, 101), event(2, 100)];
	});
	const reader = createReader(f.relay, f.connection, channelId, 2);
	await reader.start();
	await reader.next();
	assert.deepEqual(
		reader.snapshot().rows.map((r) => r.id),
		[id(1), id(2), id(3)],
	);
	offline = true;
	await reader.refresh();
	assert.equal(reader.snapshot().rows.length, 3);
	assert.match(reader.snapshot().error, /offline/);
	reader.dispose();
});

test("reopen presents saved artifacts before the network settles, reads only changes and retains the older cursor", async () => {
	const cache = memoryCache(),
		first = fixture(async ([filter]) =>
			filter.before_id
				? [event(3, 99), event(4, 98)]
				: [event(1, 101), event(2, 100)],
		);
	const old = createReader(first.relay, first.connection, channelId, 2, cache);
	await old.start();
	await old.next();
	old.dispose();
	const gate = deferred(),
		second = fixture(() => gate.promise);
	const reopened = createReader(
		second.relay,
		second.connection,
		channelId,
		2,
		cache,
	);
	const starting = reopened.start();
	await until(() => second.requests.length === 1);
	assert.equal(reopened.snapshot().rows.length, 4);
	assert.equal(reopened.snapshot().cached, true);
	assert.equal(reopened.snapshot().pending, true);
	assert.equal(second.requests[0][0][0].since, 101);
	assert.equal(second.views.length, 0);
	gate.resolve([event(9, 102)]);
	await starting;
	assert.equal(reopened.snapshot().rows.length, 5);
	assert.equal(second.views.length, 1);
	assert.equal(
		(await cache.load(cacheScope(second.connection, channelId))).meta.older
			.before_id,
		id(4),
	);
	reopened.dispose();
});

test("same-second incremental catch-up drains every page and does not recreate known readers", async () => {
	const cache = memoryCache(),
		first = fixture(async () => [event(1, 100)]);
	const old = createReader(first.relay, first.connection, channelId, 2, cache);
	await old.start();
	old.dispose();
	const second = fixture(async ([filter]) => {
		assert.equal(filter.since, 100);
		return filter.before_id ? [event(3, 100)] : [event(1, 100), event(2, 100)];
	});
	const reopened = createReader(
		second.relay,
		second.connection,
		channelId,
		2,
		cache,
	);
	await reopened.start();
	assert.equal(second.requests.length, 2);
	assert.equal(second.views.length, 2);
	assert.deepEqual(
		reopened.snapshot().rows.map((r) => r.id),
		[id(1), id(2), id(3)],
	);
	reopened.dispose();
});

test("missed edits and deletes update old cached artifacts through the host's exact fold", async () => {
	const cache = memoryCache(),
		first = fixture();
	const old = createReader(first.relay, first.connection, channelId, 12, cache);
	await old.start();
	old.dispose();
	const edit = {
			...event(70, 110),
			kind: 40003,
			tags: [
				["h", channelId],
				["e", id(1)],
			],
		},
		deletion = {
			...event(71, 111),
			kind: 5,
			tags: [
				["h", channelId],
				["e", id(2)],
			],
		};
	const second = fixture(async () => [deletion, edit]);
	const open = second.session.thread;
	second.session.thread = (...args) => {
		const view = open(...args);
		view.refresh = async () =>
			view.update(
				args[1] === id(2)
					? { targetStatus: "unavailable" }
					: {
							targetStatus: "ready",
							target: row(1, { content: "edited https://example.com/new" }),
						},
			);
		return view;
	};
	const reopened = createReader(
		second.relay,
		second.connection,
		channelId,
		12,
		cache,
	);
	await reopened.start();
	assert.deepEqual(
		reopened.snapshot().rows.map((r) => r.content),
		["edited https://example.com/new"],
	);
	reopened.dispose();
	const third = fixture(async () => []),
		again = createReader(third.relay, third.connection, channelId, 12, cache);
	await again.start();
	assert.equal(again.snapshot().rows.length, 1);
	assert.equal(third.views.length, 0);
	again.dispose();
});

test("a failed target cannot advance the saved incremental checkpoint", async () => {
	const cache = memoryCache(),
		f = fixture();
	const reader = createReader(f.relay, f.connection, channelId, 12, cache);
	await reader.start();
	const edit = {
		...event(70, 110),
		kind: 40003,
		tags: [
			["h", channelId],
			["e", id(1)],
		],
	};
	f.session.readRemote = async (...args) => {
		f.requests.push(args);
		return [edit];
	};
	f.views[0].refresh = async () => f.views[0].update({ targetStatus: "error" });
	await reader.refresh();
	assert.equal(reader.snapshot().rows.length, 2);
	assert.equal(
		(await cache.load(cacheScope(f.connection, channelId))).meta.checkpoint,
		100,
	);
	reader.dispose();
});

test("200 accumulated messages keep at most 12 host readers and dispose all subscriptions", async () => {
	const events = Array.from({ length: 200 }, (_, i) => event(i + 1, 1000 - i));
	const f = fixture(async ([filter]) =>
		events
			.filter(
				(e) =>
					filter.until === undefined ||
					e.created_at < filter.until ||
					(e.created_at === filter.until && e.id > filter.before_id),
			)
			.slice(0, filter.limit),
	);
	const reader = createReader(f.relay, f.connection, channelId);
	await reader.start();
	let peak = 0;
	while (reader.snapshot().more) {
		await reader.next();
		peak = Math.max(peak, f.views.filter((view) => !view.disposed).length);
	}
	assert.equal(reader.snapshot().rows.length, 200);
	assert.ok(peak <= 12);
	reader.dispose();
	assert.equal(f.owned(), 0);
	assert.ok(f.views.every((view) => view.disposed));
});

test("cache write failure is visible without losing the working collection", async () => {
	const cache = memoryCache();
	cache.commit = async () => {
		throw Error("disk full");
	};
	const f = fixture(),
		reader = createReader(f.relay, f.connection, channelId, 12, cache);
	await reader.start();
	assert.equal(reader.snapshot().rows.length, 2);
	assert.match(reader.snapshot().cacheError, /本地缓存/);
	reader.dispose();
});

test("late local hydration cannot repopulate a revoked panel; reconnect does not erase the cache", async () => {
	const cache = memoryCache(),
		f = fixture(),
		old = createReader(f.relay, f.connection, channelId, 12, cache);
	await old.start();
	old.dispose();
	const saved = await cache.load(cacheScope(f.connection, channelId)),
		gate = deferred();
	const second = fixture(),
		delayedCache = { ...cache, load: () => gate.promise };
	const reader = createReader(
		second.relay,
		second.connection,
		channelId,
		12,
		delayedCache,
	);
	const starting = reader.start();
	second.revoke();
	gate.resolve(saved);
	await starting;
	assert.equal(reader.snapshot().rows.length, 0);
	assert.equal(second.requests.length, 0);
	reader.dispose();
	const third = fixture(),
		restored = createReader(
			third.relay,
			third.connection,
			channelId,
			12,
			cache,
		);
	await restored.start();
	third.reconnect();
	await until(() => restored.snapshot().rows.length === 0);
	assert.ok(
		(await cache.load(cacheScope(third.connection, channelId))).records.length >
			0,
	);
	restored.dispose();
});

test("cached document preview is scoped and does not make a network request", async () => {
	const cache = memoryCache(),
		f = fixture(),
		reader = createReader(f.relay, f.connection, channelId, 12, cache);
	await reader.start();
	const source = `http://buzz-media.localhost/${encodeURIComponent(`https://relay.example/media/${id(1)}.md`)}`;
	await cache.text(cacheScope(f.connection, channelId), source, {
		text: "saved document",
		truncated: false,
	});
	assert.deepEqual(await reader.text(source, new AbortController().signal), {
		text: "saved document",
		truncated: false,
	});
	await assert.rejects(
		reader.text("file:///etc/passwd", new AbortController().signal),
	);
	f.revoke();
	await assert.rejects(
		reader.text(source, new AbortController().signal),
		/权限/,
	);
	reader.dispose();
});

test("an already synchronized boundary edit is not fetched again on reopen", async () => {
	const cache = memoryCache(),
		first = fixture();
	const reader = createReader(
		first.relay,
		first.connection,
		channelId,
		12,
		cache,
	);
	await reader.start();
	const edit = {
		...event(80, 110),
		kind: 40003,
		tags: [
			["h", channelId],
			["e", id(1)],
		],
	};
	first.session.readRemote = async () => [edit];
	await reader.refresh();
	reader.dispose();
	const second = fixture(async () => [edit]),
		reopened = createReader(
			second.relay,
			second.connection,
			channelId,
			12,
			cache,
		);
	await reopened.start();
	assert.equal(second.views.length, 0);
	assert.equal(reopened.snapshot().rows.length, 2);
	reopened.dispose();
});

test("revocation during a text-cache commit fences its late return and clears saved bytes", async () => {
	const cache = memoryCache(),
		f = fixture(),
		reader = createReader(f.relay, f.connection, channelId, 12, cache);
	await reader.start();
	const gate = deferred(),
		originalText = cache.text;
	let writing = false;
	cache.text = async (...args) => {
		if (args[2]) {
			writing = true;
			await gate.promise;
		}
		return originalText(...args);
	};
	const source = `http://buzz-media.localhost/${encodeURIComponent(`https://relay.example/media/${id(4)}.md`)}`;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("private document");
	try {
		const result = reader.text(source, new AbortController().signal);
		await until(() => writing);
		f.revoke();
		gate.resolve();
		await assert.rejects(result, /权限/);
		await until(() => cache.partitions.size === 0);
		assert.equal(
			await originalText(cacheScope(f.connection, channelId), source),
			undefined,
		);
	} finally {
		globalThis.fetch = originalFetch;
		reader.dispose();
	}
});

test("a corrupt persisted cursor falls back to a fresh head without sending it to the relay", async () => {
	const cache = memoryCache(),
		f = fixture();
	await cache.commit(cacheScope(f.connection, channelId), [], {
		initialized: true,
		checkpoint: 100,
		pages: 2,
		more: true,
		older: { until: "bad", before_id: "bad" },
	});
	const reader = createReader(f.relay, f.connection, channelId, 12, cache);
	await reader.start();
	assert.equal(reader.snapshot().rows.length, 2);
	assert.equal(f.requests[0][0][0].since, undefined);
	assert.equal(f.requests[0][0][0].until, undefined);
	reader.dispose();
});
