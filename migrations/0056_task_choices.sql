-- phase: expand
CREATE TABLE ai_tasks (
 name text PRIMARY KEY, service text NOT NULL, kind text NOT NULL,
 sentence text NOT NULL, builtin text NOT NULL, workflow text NOT NULL,
 updated_at text NOT NULL
);
CREATE TABLE ai_task_choices (
 subject text NOT NULL, task text NOT NULL REFERENCES ai_tasks(name),
 choice text NOT NULL, updated_at text NOT NULL, PRIMARY KEY(subject, task)
);
CREATE TABLE ai_task_defaults (
 task text PRIMARY KEY REFERENCES ai_tasks(name), value text NOT NULL,
 updated_by text NOT NULL, updated_at text NOT NULL
);
