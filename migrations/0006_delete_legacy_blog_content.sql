-- The blog has been replaced by encrypted private notes. Permanently remove
-- legacy plaintext blog content while preserving accounts, vaults, and notes.
DELETE FROM post_categories;
DELETE FROM posts;
DELETE FROM pages;
DELETE FROM categories;
DELETE FROM media_assets;
