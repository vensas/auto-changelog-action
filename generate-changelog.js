#!/usr/bin/env node
'use strict';

/**
 * AI-Powered Changelog Generator using GitHub Models
 *
 * Analyzes PR diffs and calls the GitHub Models API to generate Keep a Changelog
 * formatted entries. Updates each configured package's CHANGELOG.md in place.
 *
 * Required environment variables:
 *   AI_API_KEY       - GitHub Models API key
 *   PR_NUMBER        - Pull request number
 *   PR_TITLE         - Pull request title
 *   BASE_REF         - Base branch name (e.g. main)
 *   REPO_OWNER       - Repository owner
 *   REPO_NAME        - Repository name
 *   PACKAGES_CONFIG  - JSON array of package configurations
 *
 * Optional environment variables:
 *   PR_BODY              - Pull request description (for linked issue extraction)
 *   GITHUB_TOKEN         - GitHub token for fetching linked issue details
 *   PROJECT_CONTEXT      - Short project description for the AI prompt
 *   AI_MODEL             - Model identifier (default: gpt-4.1)
 *   GITHUB_MODELS_API_URL - API endpoint URL
 *   MAX_DIFF_CHARS       - Max diff characters sent to the AI (default: 8000)
 *   DRY_RUN              - When "true", prints entries without modifying any files
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GITHUB_MODELS_API = process.env.GITHUB_MODELS_API_URL || 'https://models.github.ai/inference/chat/completions';
const MODEL = process.env.AI_MODEL || 'gpt-4.1';
const GITHUB_API = 'https://api.github.com';

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_DIFF_CHARS = parseInt(process.env.MAX_DIFF_CHARS, 10) || 8000;
const DRY_RUN = process.env.DRY_RUN === 'true';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Parse and validate the packages configuration from the PACKAGES_CONFIG env var.
 * @returns {Array<{name: string, path: string, changelogFile: string, description: string, patterns: string[]}>}
 */
function loadPackagesConfig() {
  const raw = process.env.PACKAGES_CONFIG;
  if (!raw) {
    throw new Error('PACKAGES_CONFIG environment variable is required');
  }

  let packages;
  try {
    packages = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid PACKAGES_CONFIG JSON: ${err.message}`);
  }

  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error('PACKAGES_CONFIG must be a non-empty JSON array');
  }

  for (const pkg of packages) {
    if (!pkg.name || !pkg.path || !pkg.changelogFile || !Array.isArray(pkg.patterns)) {
      throw new Error(
        `Invalid package config: ${JSON.stringify(pkg)}. ` +
        'Each entry must have: name, path, changelogFile, patterns'
      );
    }
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Return the list of files changed between the base branch and HEAD.
 */
function getChangedFiles(baseRef) {
  try {
    const files = execSync(`git diff --name-only origin/${baseRef}...HEAD`, { encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);
    return files;
  } catch (error) {
    console.error('Error getting changed files:', error.message);
    return [];
  }
}

/**
 * Return the diff for a specific package, filtered to its path patterns.
 */
function getPackageDiff(baseRef, patterns) {
  try {
    const pathArgs = patterns
      .map(p => p.replace(/^\^/, '').replace(/\/$/, ''))
      .join(' ');
    return execSync(`git diff origin/${baseRef}...HEAD -- ${pathArgs}`, { encoding: 'utf-8' });
  } catch (error) {
    console.error(`Error getting diff for patterns ${patterns}:`, error.message);
    return '';
  }
}

/**
 * Return the subset of packages that have relevant source-file changes.
 * Changelog files, test files, and GitHub infrastructure files are excluded.
 */
function getAffectedPackages(files, packages) {
  return packages.filter(pkg =>
    files.some(file => {
      if (
        file.includes('CHANGELOG.md') ||
        file.includes('.test.') ||
        file.includes('.spec.') ||
        file.includes('__tests__/') ||
        file.includes('.Tests/') ||
        file.match(/^\.github\/(workflows|scripts)\//)
      ) {
        return false;
      }
      return pkg.patterns.some(pattern => new RegExp(pattern).test(file));
    })
  );
}

// ---------------------------------------------------------------------------
// GitHub Issues API
// ---------------------------------------------------------------------------

/**
 * Extract issue numbers referenced by closing keywords in the PR body.
 * Matches: closes, close, closed, fix, fixes, fixed, resolve, resolves, resolved
 */
function extractLinkedIssueNumbers(prBody) {
  const re = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  const seen = new Set();
  let match;
  while ((match = re.exec(prBody)) !== null) {
    seen.add(parseInt(match[1], 10));
  }
  return [...seen];
}

/**
 * Fetch details for a single issue. Returns null if the number refers to a PR
 * or if the request fails.
 */
async function fetchIssueDetails(issueNumber, repoOwner, repoName, token) {
  const url = `${GITHUB_API}/repos/${repoOwner}/${repoName}/issues/${issueNumber}`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'auto-changelog-action'
      }
    });

    if (!response.ok) {
      console.warn(`⚠️  Could not fetch issue #${issueNumber}: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data.pull_request) {
      console.log(`ℹ️  #${issueNumber} is a pull request, skipping`);
      return null;
    }

    return {
      number: data.number,
      title: data.title,
      body: (data.body || '').substring(0, 2000)
    };
  } catch (error) {
    console.warn(`⚠️  Error fetching issue #${issueNumber}:`, error.message);
    return null;
  }
}

/**
 * Fetch all issues linked via closing keywords in the PR body.
 */
async function fetchLinkedIssues(prBody, repoOwner, repoName, token) {
  const numbers = extractLinkedIssueNumbers(prBody);
  if (numbers.length === 0) return [];

  const results = await Promise.all(
    numbers.map(n => fetchIssueDetails(n, repoOwner, repoName, token))
  );
  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------
// AI prompt helpers
// ---------------------------------------------------------------------------

function buildIssueContext(linkedIssues, prNumber, prTitle) {
  if (linkedIssues.length > 0) {
    return linkedIssues
      .map(issue => `Issue #${issue.number}: ${issue.title}\n${issue.body.trim()}`)
      .join('\n\n---\n\n');
  }
  return `No linked issues found. PR #${prNumber}: ${prTitle}`;
}

/**
 * Build the reference link that will be appended to every changelog entry.
 * Prefers the first linked issue; falls back to the PR itself.
 */
function buildEntryLink(linkedIssues, prNumber, repoOwner, repoName) {
  if (linkedIssues.length > 0) {
    const issue = linkedIssues[0];
    return `[#${issue.number}](https://github.com/${repoOwner}/${repoName}/issues/${issue.number})`;
  }
  return `[#${prNumber}](https://github.com/${repoOwner}/${repoName}/pull/${prNumber})`;
}

// ---------------------------------------------------------------------------
// GitHub Models API
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call the GitHub Models API to generate changelog entries for one package.
 * Retries up to MAX_RETRIES times with exponential back-off.
 *
 * @returns {{ versionBump: string, category: string, entries: string[] }}
 */
async function generateChangelogEntries(
  prNumber, prTitle, prBody, diff,
  packageInfo, linkedIssues, repoOwner, repoName
) {
  const token = process.env.AI_API_KEY;
  if (!token) {
    throw new Error('AI_API_KEY environment variable is not set');
  }

  const projectContext = process.env.PROJECT_CONTEXT || '';
  const issueContext = buildIssueContext(linkedIssues, prNumber, prTitle);
  const entryLink = buildEntryLink(linkedIssues, prNumber, repoOwner, repoName);

  const projectContextSection = projectContext
    ? `PROJECT CONTEXT:\n${projectContext}\n\n`
    : '';

  const prompt = `You are a technical writer creating changelog entries following the Keep a Changelog format.

${projectContextSection}PACKAGE:
${packageInfo.name}: ${packageInfo.description || packageInfo.name}

ISSUE CONTEXT (what was planned / why this PR exists):
${issueContext}

CODE CHANGES (filtered to ${packageInfo.name} only):
${diff.substring(0, MAX_DIFF_CHARS)}${diff.length > MAX_DIFF_CHARS ? '\n... (diff truncated)' : ''}

TASK:
1. Use the ISSUE CONTEXT to understand the intent behind the PR.
2. Use the CODE CHANGES as the ultimate source of truth for what was actually implemented.
3. You may use the ISSUE CONTEXT to explain motivation, but entry descriptions must be grounded in CODE CHANGES.
4. If the code reveals additional changes not mentioned in the issue, include them.
5. Describe changes at a user-facing, high level — not implementation details.

VERSION BUMP RULES:
- major: Breaking changes, removed features, incompatible API changes
- minor: New features, backward-compatible additions
- patch: Bug fixes, documentation, refactoring, dependency updates

CHANGELOG CATEGORIES (Keep a Changelog):
- Added: New features
- Changed: Changes to existing functionality
- Deprecated: Features marked for removal
- Removed: Removed features
- Fixed: Bug fixes
- Security: Security fixes or improvements

ENTRY GUIDELINES:
- Do NOT create entries for: added translations, added tests, minor refactors, linting fixes, or dependency bumps — UNLESS they are the only change
- Be concise; one to two short sentences is ideal
- Each entry must end with: ${entryLink}
- Each entry starts with a lowercase verb (e.g. "add", "fix", "allow", "show")

RESPONSE FORMAT (JSON only, no markdown code fences):
{
  "versionBump": "major|minor|patch",
  "category": "Added|Changed|Fixed|etc",
  "entries": [
    "description of change ${entryLink}"
  ]
}

Respond with ONLY valid JSON:`;

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(GITHUB_MODELS_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          messages: [
            {
              role: 'system',
              content: 'You are a technical writer. Always respond with valid JSON only, no markdown formatting.'
            },
            { role: 'user', content: prompt }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`GitHub Models API error (${response.status}): ${errorText}`);

        if (response.status === 401) {
          error.message += '\n\n🔑 Authentication failed. Verify that AI_API_KEY is a valid GitHub Models token.';
        } else if (response.status === 403) {
          error.message += '\n\n🚫 Access denied. GitHub Models requires a GitHub Copilot for Business subscription.';
        } else if (response.status === 404) {
          error.message += `\n\n❓ Model "${MODEL}" not found. Check available models at https://github.com/marketplace/models`;
        } else if (response.status === 429) {
          error.message += '\n\n⏱️ Rate limit exceeded. Will retry...';
        }

        throw error;
      }

      const data = await response.json();
      if (!data.choices?.[0]?.message) {
        throw new Error('Unexpected API response structure: ' + JSON.stringify(data));
      }

      const jsonContent = data.choices[0].message.content
        .trim()
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      return JSON.parse(jsonContent);

    } catch (error) {
      lastError = error;
      console.error(`✗ Attempt ${attempt} failed:`, error.message);

      // Do not retry on auth / permission errors
      if (error.message.includes('401') || error.message.includes('403')) {
        throw error;
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY * attempt;
        console.log(`⏳ Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(`Failed after ${MAX_RETRIES} attempts. Last error: ${lastError.message}`);
}

// ---------------------------------------------------------------------------
// Changelog file manipulation
// ---------------------------------------------------------------------------

/**
 * Clear the [Unreleased] section of a CHANGELOG.md, removing all generated content
 * while preserving the header and any subsequent release sections.
 * Returns true if the file was modified.
 */
function clearChangelogUnreleased(changelogPath) {
  let content;
  try {
    content = fs.readFileSync(changelogPath, 'utf-8');
  } catch {
    return false;
  }

  const headerIdx = content.indexOf('## [Unreleased]');
  if (headerIdx === -1) return false;

  // Find where the [Unreleased] section ends (start of next ## heading)
  const nextSectionIdx = content.indexOf('\n## ', headerIdx + 1);
  const sectionContent = nextSectionIdx === -1
    ? content.slice(headerIdx)
    : content.slice(headerIdx, nextSectionIdx);

  // Nothing to clear if section body is already empty
  const afterHeaderNewline = sectionContent.indexOf('\n');
  if (afterHeaderNewline === -1 || !sectionContent.slice(afterHeaderNewline).trim()) {
    return false;
  }

  const replacement = '## [Unreleased]\n\n';
  const newContent = nextSectionIdx === -1
    ? content.slice(0, headerIdx) + replacement
    : content.slice(0, headerIdx) + replacement + content.slice(nextSectionIdx);

  try {
    fs.writeFileSync(changelogPath, newContent, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write ${changelogPath}: ${error.message}`);
  }
  return true;
}

/**
 * Update the [Unreleased] section of a CHANGELOG.md file, replacing any
 * existing content with the newly generated entries.
 */
function updateChangelog(changelogPath, versionBump, category, entries) {
  let content;
  try {
    content = fs.readFileSync(changelogPath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read ${changelogPath}: ${error.message}`);
  }

  if (!content.includes('## [Unreleased]')) {
    throw new Error(
      `${changelogPath} is missing an [Unreleased] section. ` +
      'Add "## [Unreleased]" to the file before using this action.'
    );
  }

  const validBumps = ['major', 'minor', 'patch'];
  if (!validBumps.includes(versionBump)) {
    throw new Error(`Invalid versionBump "${versionBump}". Must be one of: ${validBumps.join(', ')}`);
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('entries must be a non-empty array');
  }

  const validCategories = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
  if (!validCategories.includes(category)) {
    console.warn(`⚠️  Unusual category "${category}". Standard: ${validCategories.join(', ')}`);
  }

  const versionComment = `<!-- Version: ${versionBump} -->`;
  const categorySection = `### ${category}\n${entries.map(e => `- ${e}`).join('\n')}`;
  const newUnreleasedSection = `## [Unreleased]\n${versionComment}\n\n${categorySection}\n`;

  // Match the [Unreleased] section up to (but not including) the next release header
  const unreleasedRegex = /## \[Unreleased\]\s*\n(?:<!--[\s\S]*?-->\s*\n)?(?:###[\s\S]*?)?(?=\n## )/;

  if (content.match(unreleasedRegex)) {
    content = content.replace(unreleasedRegex, newUnreleasedSection);
  } else {
    // [Unreleased] is at the end of the file with no subsequent release header
    content = content.replace(/## \[Unreleased\]\s*\n/, newUnreleasedSection);
  }

  try {
    fs.writeFileSync(changelogPath, content, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write ${changelogPath}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { PR_NUMBER, PR_TITLE, PR_BODY, BASE_REF, REPO_OWNER, REPO_NAME } = process.env;

  if (!PR_NUMBER || !PR_TITLE || !BASE_REF || !REPO_OWNER || !REPO_NAME) {
    throw new Error(
      'Missing required environment variables: PR_NUMBER, PR_TITLE, BASE_REF, REPO_OWNER, REPO_NAME'
    );
  }

  const packages = loadPackagesConfig();
  const files = getChangedFiles(BASE_REF);

  if (files.length === 0) {
    console.log('No changed files detected.');
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'has_changes=false\n');
    }
    return;
  }

  const affected = getAffectedPackages(files, packages);

  if (affected.length === 0) {
    // No source-file changes detected — clear any previously generated [Unreleased] content
    // so stale entries don't linger after a code revert.
    let cleared = false;
    if (DRY_RUN) {
      console.log('ℹ️  [dry-run] No source changes — would clear [Unreleased] sections');
    } else {
      for (const pkg of packages) {
        const changelogPath = path.join(pkg.path, pkg.changelogFile);
        if (clearChangelogUnreleased(changelogPath)) {
          console.log(`Cleared [Unreleased] section in ${changelogPath}`);
          cleared = true;
        }
      }
    }
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_changes=${cleared}\nupdates=\ncleared=${cleared}\n`);
    }
    return;
  }

  console.log(`Affected packages: ${affected.map(p => p.name).join(', ')}`);

  const githubToken = process.env.GITHUB_TOKEN || process.env.AI_API_KEY;
  const linkedIssues = await fetchLinkedIssues(PR_BODY || '', REPO_OWNER, REPO_NAME, githubToken);

  if (linkedIssues.length > 0) {
    console.log(`ℹ️  Linked issues: ${linkedIssues.map(i => `#${i.number}`).join(', ')}`);
  } else {
    console.log('ℹ️  No linked issues found — changelog entries will link to the PR');
  }

  if (DRY_RUN) {
    console.log('ℹ️  dry-run mode enabled — CHANGELOG.md files will not be modified');
  }

  const updates = [];
  const generatedEntries = [];

  for (const pkg of affected) {
    console.log(`\nProcessing package: ${pkg.name}`);

    const pkgDiff = getPackageDiff(BASE_REF, pkg.patterns);
    if (!pkgDiff || pkgDiff.trim().length === 0) {
      console.log(`  No diff content for ${pkg.name}, skipping`);
      continue;
    }

    const changelogPath = path.join(pkg.path, pkg.changelogFile);
    if (!fs.existsSync(changelogPath)) {
      console.warn(`  ⚠️  ${changelogPath} not found, skipping`);
      continue;
    }

    const result = await generateChangelogEntries(
      PR_NUMBER, PR_TITLE, PR_BODY || '',
      pkgDiff, pkg, linkedIssues, REPO_OWNER, REPO_NAME
    );

    if (!result) {
      console.warn(`  ⚠️  No result returned from AI for ${pkg.name}`);
      continue;
    }

    const entryWord = result.entries.length === 1 ? 'entry' : 'entries';
    const categoryMarkdown = `### ${result.category}\n${result.entries.map(e => `- ${e}`).join('\n')}`;
    console.log(`  → ${result.versionBump} bump | ${result.category} | ${result.entries.length} ${entryWord}`);

    if (DRY_RUN) {
      console.log(`  [dry-run] Skipping file write. Generated entries:\n  ${categoryMarkdown.split('\n').join('\n  ')}`);
    } else {
      updateChangelog(changelogPath, result.versionBump, result.category, result.entries);
    }

    updates.push(`${pkg.name}: ${result.versionBump}`);
    generatedEntries.push({ name: pkg.name, versionBump: result.versionBump, markdown: categoryMarkdown });
  }

  // Emit generated-entry output (multiline, set regardless of dry-run)
  if (generatedEntries.length > 0) {
    const generatedMarkdown = generatedEntries.length === 1
      ? generatedEntries[0].markdown
      : generatedEntries.map(e => `**${e.name}** (${e.versionBump})\n${e.markdown}`).join('\n\n');

    if (DRY_RUN && process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Changelog entries (dry run)\n\n${generatedMarkdown}\n`
      );
    }

    if (process.env.GITHUB_OUTPUT) {
      const delimiter = `ghadelimiter_${Date.now()}`;
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `generated_entry<<${delimiter}\n${generatedMarkdown}\n${delimiter}\n`
      );
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    const filesChanged = !DRY_RUN && updates.length > 0;
    if (filesChanged) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `has_changes=true\nupdates=${updates.join(', ')}\ncleared=false\n`
      );
    } else {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_changes=false\nupdates=${updates.join(', ')}\ncleared=false\n`);
    }
  }
}

main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  console.error(error.stack);

  if (process.env.GITHUB_OUTPUT) {
    const errorMsg = error.message.replace(/\n/g, ' ').substring(0, 200);
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `has_changes=false\nerror_message=${errorMsg}\n`
    );
  }

  process.exit(1);
});
