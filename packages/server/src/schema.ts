/**
 * Tables. Dates are ISO strings (`YYYY-MM-DD`, or a full timestamp), kept as
 * text so that nothing shifts them between time zones on the way.
 */

import { type Db, MAIN, MEMORY_DB, STATE_DB } from "./dolt.ts";

/** Memory: versioned, branched for reviews. */
const MEMORY_TABLES = [
	`CREATE TABLE IF NOT EXISTS scopes (
		id VARCHAR(160) NOT NULL PRIMARY KEY,
		project_key VARCHAR(600),
		root VARCHAR(1024),
		charter TEXT,
		created VARCHAR(32)
	)`,
	`CREATE TABLE IF NOT EXISTS notes (
		id VARCHAR(16) NOT NULL PRIMARY KEY,
		scope VARCHAR(160) NOT NULL,
		title TEXT NOT NULL,
		type VARCHAR(16) NOT NULL,
		status VARCHAR(16) NOT NULL,
		index_mode VARCHAR(8) NOT NULL,
		when_text TEXT,
		body LONGTEXT NOT NULL,
		pinned TINYINT NOT NULL DEFAULT 0,
		enabled TINYINT NOT NULL DEFAULT 1,
		created VARCHAR(10) NOT NULL,
		updated VARCHAR(10) NOT NULL,
		confirmed VARCHAR(10),
		valid_until VARCHAR(10),
		superseded_by VARCHAR(16),
		supersedes JSON,
		evidence JSON,
		extra JSON,
		KEY notes_scope (scope)
	)`,
	`CREATE TABLE IF NOT EXISTS skills (
		scope VARCHAR(160) NOT NULL,
		name VARCHAR(64) NOT NULL,
		description TEXT NOT NULL,
		body LONGTEXT NOT NULL,
		created VARCHAR(10),
		updated VARCHAR(10),
		PRIMARY KEY (scope, name)
	)`,
	`CREATE TABLE IF NOT EXISTS prompts (
		name VARCHAR(40) NOT NULL PRIMARY KEY,
		body LONGTEXT NOT NULL,
		updated VARCHAR(32)
	)`,
];

/** State: one branch, never reviewed. */
const STATE_TABLES = [
	`CREATE TABLE IF NOT EXISTS kv (k VARCHAR(80) NOT NULL PRIMARY KEY, v JSON)`,
	`CREATE TABLE IF NOT EXISTS inbox (
		id VARCHAR(24) NOT NULL PRIMARY KEY,
		ts VARCHAR(32) NOT NULL,
		source VARCHAR(8) NOT NULL,
		text LONGTEXT NOT NULL,
		kind VARCHAR(16),
		scope VARCHAR(8),
		cwd VARCHAR(1024),
		project_key VARCHAR(600),
		session_id VARCHAR(64),
		session_file VARCHAR(1200),
		entry_id VARCHAR(64),
		status VARCHAR(12) NOT NULL DEFAULT 'pending',
		run_id VARCHAR(32),
		done_at VARCHAR(32),
		KEY inbox_status (status)
	)`,
	`CREATE TABLE IF NOT EXISTS session_marks (
		path VARCHAR(1200) NOT NULL PRIMARY KEY,
		size BIGINT NOT NULL,
		mtime_ms DOUBLE NOT NULL,
		at VARCHAR(32) NOT NULL,
		ok TINYINT NOT NULL,
		failures INT NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS runs (
		id VARCHAR(32) NOT NULL PRIMARY KEY,
		kind VARCHAR(12) NOT NULL,
		status VARCHAR(12) NOT NULL,
		trigger_by VARCHAR(16),
		started_at VARCHAR(32) NOT NULL,
		finished_at VARCHAR(32),
		pid INT,
		error TEXT,
		sessions INT,
		cost DOUBLE,
		review_id VARCHAR(32),
		title TEXT,
		opts JSON,
		report JSON
	)`,
	`CREATE TABLE IF NOT EXISTS reviews (
		id VARCHAR(32) NOT NULL PRIMARY KEY,
		branch VARCHAR(64) NOT NULL,
		status VARCHAR(12) NOT NULL,
		title TEXT,
		created_at VARCHAR(32) NOT NULL,
		closed_at VARCHAR(32),
		base_commit VARCHAR(40),
		runs JSON
	)`,
	`CREATE TABLE IF NOT EXISTS review_decisions (
		seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
		review_id VARCHAR(32) NOT NULL,
		item_key VARCHAR(260) NOT NULL,
		kind VARCHAR(16) NOT NULL,
		note_id VARCHAR(16),
		title TEXT,
		scope VARCHAR(160),
		decision VARCHAR(12) NOT NULL,
		at VARCHAR(32) NOT NULL,
		by_who VARCHAR(120),
		reason TEXT,
		KEY decisions_review (review_id)
	)`,
	`CREATE TABLE IF NOT EXISTS review_comments (
		id VARCHAR(24) NOT NULL PRIMARY KEY,
		review_id VARCHAR(32) NOT NULL,
		note_id VARCHAR(16),
		body LONGTEXT NOT NULL,
		author VARCHAR(120),
		at VARCHAR(32) NOT NULL,
		processed_run VARCHAR(32),
		unhandled TEXT,
		KEY comments_review (review_id)
	)`,
	`CREATE TABLE IF NOT EXISTS rejections (
		seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
		title TEXT NOT NULL,
		at VARCHAR(32) NOT NULL,
		review_id VARCHAR(32),
		note_id VARCHAR(16)
	)`,
	`CREATE TABLE IF NOT EXISTS note_stats (
		note_id VARCHAR(16) NOT NULL PRIMARY KEY,
		helpful INT NOT NULL DEFAULT 0,
		harmful INT NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS agents_proposals (
		id VARCHAR(24) NOT NULL PRIMARY KEY,
		run_id VARCHAR(32),
		review_id VARCHAR(32),
		project_key VARCHAR(600),
		repo_root VARCHAR(1024) NOT NULL,
		rel VARCHAR(255) NOT NULL,
		summary TEXT,
		edits JSON,
		rationale JSON,
		status VARCHAR(12) NOT NULL,
		error TEXT,
		created_at VARCHAR(32) NOT NULL,
		decided_at VARCHAR(32)
	)`,
];

export const SCHEMA_VERSION = 1;

export async function ensureSchema(db: Db, author: string): Promise<void> {
	await db.q(`CREATE DATABASE IF NOT EXISTS \`${MEMORY_DB}\``);
	await db.q(`CREATE DATABASE IF NOT EXISTS \`${STATE_DB}\``);
	await db.on(STATE_DB, async (c) => {
		for (const ddl of STATE_TABLES) await c.query(ddl);
	});
	// Every branch gets the same tables (a review branch made by an older version included).
	for (const branch of await db.branches()) {
		await db.onBranch(branch, async (c) => {
			for (const ddl of MEMORY_TABLES) await c.query(ddl);
		});
		await db.commit(branch, `wierd-mem: schema v${SCHEMA_VERSION}`, author);
	}
	await db.on(STATE_DB, async (c) => {
		await c.query("REPLACE INTO kv (k, v) VALUES ('schema_version', ?)", [JSON.stringify(SCHEMA_VERSION)]);
	});
	void MAIN;
}
