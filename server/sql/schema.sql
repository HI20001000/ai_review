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
