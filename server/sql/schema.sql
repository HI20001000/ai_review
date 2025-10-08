-- Projects table stores basic metadata about imported workspaces
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    mode VARCHAR(50) NOT NULL,
    created_at BIGINT NOT NULL
);

-- Nodes table stores flattened tree information for each project
CREATE TABLE IF NOT EXISTS nodes (
    node_key VARCHAR(512) PRIMARY KEY,
    project_id VARCHAR(255) NOT NULL,
    type ENUM('dir', 'file') NOT NULL,
    name VARCHAR(255) NOT NULL,
    path TEXT NOT NULL,
    parent TEXT,
    size BIGINT DEFAULT 0,
    last_modified BIGINT DEFAULT 0,
    mime VARCHAR(255) DEFAULT '',
    is_big TINYINT(1) DEFAULT 0,
    CONSTRAINT fk_nodes_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    INDEX idx_nodes_project (project_id),
    INDEX idx_nodes_parent (parent(255))
);

-- Reports table stores generated code review reports per file
CREATE TABLE IF NOT EXISTS reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    project_id VARCHAR(255) NOT NULL,
    path VARCHAR(1024) NOT NULL,
    report LONGTEXT NOT NULL,
    chunks_json LONGTEXT NOT NULL,
    segments_json LONGTEXT NOT NULL,
    conversation_id VARCHAR(255) DEFAULT '',
    user_id VARCHAR(255) DEFAULT '',
    generated_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_reports_project_path (project_id, path),
    INDEX idx_reports_project (project_id),
    CONSTRAINT fk_reports_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
