const { execFile } = require("child_process");

/*
 * Токены ИИ берём из базы Dify: он записывает модель и расход каждого шага
 * каждого прогона — и запущенного с сайта, и из редактора Dify. Шаги
 * читаются из фактического прогона, поэтому новый узел с ИИ попадает в учёт
 * сам, без правок здесь.
 *
 * База живёт в контейнере Dify на том же сервере, наружу не открыта —
 * читаем через docker exec, только SELECT.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const config = () => ({
  container: process.env.DIFY_DB_CONTAINER || "docker-db_postgres-1",
  appId: process.env.DIFY_APP_ID || "bf123c55-2d67-45e7-a30c-032d9553a379",
});

const defaultQuery = sql => new Promise((resolve, reject) => {
  const { container } = config();

  execFile(
    "docker",
    ["exec", container, "psql", "-U", "postgres", "-d", "dify", "-At", "-c", sql],
    { timeout: 15000, maxBuffer: 20 * 1024 * 1024 },
    (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
  );
});

// Узел, упавший до ответа модели, оставляет process_data пустым.
const NODE_COLUMNS = `
  n.title,
  n.status,
  n.elapsed_time,
  case when nullif(n.process_data, '') is null then null else n.process_data::json->>'model_name' end as model,
  case when nullif(n.process_data, '') is null then null else n.process_data::json->'usage' end as usage`;

const createDifyUsage = ({ query = defaultQuery } = {}) => ({
  async run(runId) {
    if (!UUID.test(String(runId)))
      throw new Error("Номер прогона Dify должен быть UUID");

    const sql = `
      select json_build_object(
        'run', (select row_to_json(r) from (
          select id, status, triggered_from, elapsed_time, total_tokens, created_at, finished_at
          from workflow_runs where id = '${runId}') r),
        'nodes', coalesce((select json_agg(x order by x.idx) from (
          select n."index" as idx, ${NODE_COLUMNS}
          from workflow_node_executions n
          where n.workflow_run_id = '${runId}' and n.node_type = 'llm') x), '[]'::json)
      )`;

    return JSON.parse(await query(sql));
  },

  async period(fromIso, toIso) {
    if (!ISO.test(fromIso) || !ISO.test(toIso))
      throw new Error("Границы периода должны быть в ISO UTC");

    const { appId } = config();

    // В базе Dify время без пояса, в UTC.
    const from = fromIso.replace("T", " ").replace("Z", "");
    const to = toIso.replace("T", " ").replace("Z", "");

    const sql = `
      select json_build_object(
        'runs', coalesce((select json_agg(r) from (
          select id, status, triggered_from, elapsed_time, created_at, finished_at
          from workflow_runs
          where app_id = '${appId}' and created_at >= '${from}' and created_at < '${to}') r), '[]'::json),
        'nodes', coalesce((select json_agg(x) from (
          select n.workflow_run_id as run_id, ${NODE_COLUMNS}
          from workflow_node_executions n
          join workflow_runs r on r.id = n.workflow_run_id
          where r.app_id = '${appId}' and r.created_at >= '${from}' and r.created_at < '${to}'
            and n.node_type = 'llm') x), '[]'::json)
      )`;

    return JSON.parse(await query(sql));
  },

  /*
   * Последние поиски с сайта (не прогоны из редактора Dify): запрос, итог
   * и шаги ИИ — для истории поисков и стоимости каждого.
   */
  async recentRuns(limit = 20) {
    const { appId } = config();
    const count = Math.max(1, Math.min(100, Number(limit) || 20));

    const sql = `
      with recent as (
        select id, status, elapsed_time, total_tokens, created_at, finished_at, inputs, outputs, error
        from workflow_runs
        where app_id = '${appId}' and triggered_from = 'app-run'
        order by created_at desc
        limit ${count}
      )
      select json_build_object(
        'runs', coalesce((select json_agg(r order by r.created_at desc) from recent r), '[]'::json),
        'nodes', coalesce((select json_agg(x) from (
          select n.workflow_run_id as run_id, ${NODE_COLUMNS}
          from workflow_node_executions n
          where n.workflow_run_id in (select id from recent) and n.node_type = 'llm') x), '[]'::json)
      )`;

    return JSON.parse(await query(sql));
  },
});

module.exports = { createDifyUsage, UUID };
