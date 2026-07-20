CREATE TABLE `remote_sync_state` (
  `source_path` text NOT NULL,
  `node_uid` text NOT NULL,
  `local_path` text NOT NULL,
  `remote_path` text NOT NULL,
  `parent_node_uid` text NOT NULL,
  `is_directory` integer NOT NULL,
  `revision_uid` text,
  `content_sha1` text,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`source_path`, `node_uid`)
);
--> statement-breakpoint
CREATE INDEX `idx_remote_sync_state_source` ON `remote_sync_state` (`source_path`);
