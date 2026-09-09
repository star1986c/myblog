-- Latest change per entity, including permanent deletion tombstones.
-- No historical ciphertext is duplicated. Sequence allocation and entity writes
-- are in the same SQLite transaction, including writes from older clients.
CREATE TABLE notes_sync_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL
);
INSERT INTO notes_sync_epoch VALUES (1, lower(hex(randomblob(16))));

CREATE TABLE notes_sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'folder')),
  entity_id TEXT NOT NULL,
  keyring_id TEXT NOT NULL,
  UNIQUE (kind, entity_id)
);
CREATE INDEX notes_sync_changes_workspace ON notes_sync_changes(keyring_id, sequence);

INSERT INTO notes_sync_changes(kind, entity_id, keyring_id)
SELECT 'note', id, keyring_id FROM encrypted_notes;
INSERT INTO notes_sync_changes(kind, entity_id, keyring_id)
SELECT 'folder', id, keyring_id FROM encrypted_note_folders;

CREATE TRIGGER notes_sync_note_insert
AFTER INSERT ON encrypted_notes
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('note', NEW.id, NEW.keyring_id);
END;

CREATE TRIGGER notes_sync_note_update
AFTER UPDATE ON encrypted_notes
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('note', NEW.id, NEW.keyring_id);
END;

CREATE TRIGGER notes_sync_note_delete
AFTER DELETE ON encrypted_notes
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('note', OLD.id, OLD.keyring_id);
END;

CREATE TRIGGER notes_sync_folder_insert
AFTER INSERT ON encrypted_note_folders
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('folder', NEW.id, NEW.keyring_id);
END;

CREATE TRIGGER notes_sync_folder_update
AFTER UPDATE ON encrypted_note_folders
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('folder', NEW.id, NEW.keyring_id);
END;

CREATE TRIGGER notes_sync_folder_delete
AFTER DELETE ON encrypted_note_folders
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('folder', OLD.id, OLD.keyring_id);
END;

CREATE TRIGGER notes_sync_attachment_insert
AFTER INSERT ON encrypted_note_attachments
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('note', NEW.note_id, NEW.keyring_id);
END;

CREATE TRIGGER notes_sync_attachment_update
AFTER UPDATE ON encrypted_note_attachments
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('note', NEW.note_id, NEW.keyring_id);
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  SELECT 'note', OLD.note_id, OLD.keyring_id WHERE OLD.note_id <> NEW.note_id;
END;

CREATE TRIGGER notes_sync_attachment_delete
AFTER DELETE ON encrypted_note_attachments
BEGIN
  INSERT OR REPLACE INTO notes_sync_changes(kind, entity_id, keyring_id)
  VALUES ('note', OLD.note_id, OLD.keyring_id);
END;
