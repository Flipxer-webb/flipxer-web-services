import { readFile, writeFile } from 'node:fs/promises';

const TASK_REPORT_PATH = '.scannerwork/report-task.txt';
const SARIF_OUTPUT_PATH = process.env.SARIF_OUTPUT || 'sonarqube-results.sarif';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseProperties(rawText) {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .reduce((accumulator, line) => {
      const separatorIndex = line.indexOf('=');

      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      accumulator[key] = value;
      return accumulator;
    }, {});
}

function getApiHeaders(token) {
  const auth = Buffer.from(`${token}:`).toString('base64');
  return {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
  };
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: getApiHeaders(token),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sonar API request failed (${response.status} ${response.statusText}) for ${url}: ${body}`);
  }

  return response.json();
}

async function waitForAnalysis(serverUrl, ceTaskId, token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const taskUrl = new URL('/api/ce/task', serverUrl);
  taskUrl.searchParams.set('id', ceTaskId);

  while (Date.now() < deadline) {
    const payload = await fetchJson(taskUrl, token);
    const status = payload.task?.status;

    if (status === 'SUCCESS') {
      return payload.task;
    }

    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(`Sonar analysis task ended with status ${status}`);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }

  throw new Error('Timed out waiting for Sonar analysis to complete');
}

function getAnalysisScope() {
  const eventName = process.env.GITHUB_EVENT_NAME;

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const eventPath = getRequiredEnv('GITHUB_EVENT_PATH');
    return readFile(eventPath, 'utf8').then((content) => {
      const event = JSON.parse(content);
      const pullRequestNumber = event.pull_request?.number;

      if (!pullRequestNumber) {
        throw new Error('Unable to determine pull request number from GitHub event payload');
      }

      return { pullRequest: String(pullRequestNumber) };
    });
  }

  const branch = process.env.GITHUB_REF_NAME;
  if (!branch) {
    throw new Error('Unable to determine branch name from GITHUB_REF_NAME');
  }

  return Promise.resolve({ branch });
}

async function fetchAllVulnerabilities(serverUrl, projectKey, token, scope) {
  const issues = [];
  let page = 1;
  let total = 0;

  do {
    const url = new URL('/api/issues/search', serverUrl);
    url.searchParams.set('componentKeys', projectKey);
    url.searchParams.set('types', 'VULNERABILITY');
    url.searchParams.set('resolved', 'false');
    url.searchParams.set('ps', '500');
    url.searchParams.set('p', String(page));

    if (scope.pullRequest) {
      url.searchParams.set('pullRequest', scope.pullRequest);
    }

    if (scope.branch) {
      url.searchParams.set('branch', scope.branch);
    }

    const payload = await fetchJson(url, token);
    issues.push(...(payload.issues || []));
    total = payload.paging?.total || issues.length;
    page += 1;
  } while (issues.length < total);

  return issues;
}

function extractPath(componentKey) {
  const separatorIndex = componentKey.indexOf(':');
  if (separatorIndex === -1) {
    return componentKey;
  }

  return componentKey.slice(separatorIndex + 1);
}

function mapSeverity(severity) {
  switch (severity) {
    case 'BLOCKER':
      return { level: 'error', securitySeverity: '9.0' };
    case 'CRITICAL':
      return { level: 'error', securitySeverity: '8.0' };
    case 'MAJOR':
      return { level: 'warning', securitySeverity: '6.0' };
    case 'MINOR':
      return { level: 'warning', securitySeverity: '3.0' };
    default:
      return { level: 'note', securitySeverity: '0.1' };
  }
}

function buildSarif(issues) {
  const rules = new Map();
  const results = issues
    .filter((issue) => issue.component)
    .map((issue) => {
      const { level, securitySeverity } = mapSeverity(issue.severity);
      const ruleId = issue.rule || 'sonarqube-vulnerability';

      if (!rules.has(ruleId)) {
        rules.set(ruleId, {
          id: ruleId,
          name: ruleId,
          shortDescription: {
            text: `SonarQube rule ${ruleId}`,
          },
          defaultConfiguration: {
            level,
          },
          properties: {
            tags: ['security', 'sonarqube'],
            'security-severity': securitySeverity,
          },
        });
      }

      const startLine = issue.textRange?.startLine || issue.line || 1;
      const endLine = issue.textRange?.endLine || startLine;
      const startColumn = issue.textRange?.startOffset;
      const endColumn = issue.textRange?.endOffset;
      const region = {
        startLine,
        endLine,
      };

      if (typeof startColumn === 'number') {
        region.startColumn = startColumn + 1;
      }

      if (typeof endColumn === 'number') {
        region.endColumn = endColumn + 1;
      }

      return {
        ruleId,
        level,
        message: {
          text: issue.message,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: extractPath(issue.component),
              },
              region,
            },
          },
        ],
        fingerprints: {
          'sonarqube/issue-key': issue.key,
        },
        properties: {
          tags: issue.tags || [],
          'security-severity': securitySeverity,
          precision: 'very-high',
          problem: {
            severity: issue.severity || 'INFO',
          },
        },
      };
    });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'SonarQube',
            informationUri: 'https://www.sonarsource.com/products/sonarqube/',
            rules: [...rules.values()],
          },
        },
        results,
      },
    ],
  };
}

async function main() {
  const token = getRequiredEnv('SONAR_TOKEN');
  const taskReportContent = await readFile(TASK_REPORT_PATH, 'utf8');
  const taskReport = parseProperties(taskReportContent);
  const ceTaskId = taskReport.ceTaskId;
  const projectKey = taskReport.projectKey;
  const serverUrl = taskReport.serverUrl;

  if (!ceTaskId || !projectKey || !serverUrl) {
    throw new Error(`Unexpected Sonar task report contents in ${TASK_REPORT_PATH}`);
  }

  const scope = await getAnalysisScope();
  await waitForAnalysis(serverUrl, ceTaskId, token);
  const issues = await fetchAllVulnerabilities(serverUrl, projectKey, token, scope);
  const sarif = buildSarif(issues);

  await writeFile(SARIF_OUTPUT_PATH, `${JSON.stringify(sarif, null, 2)}\n`, 'utf8');

  console.log(`Exported ${issues.length} SonarQube vulnerabilities to ${SARIF_OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});