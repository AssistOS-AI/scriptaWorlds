// The omp child process of one turn: spawn, the JSON event stream it writes to stdout, the deadline,
// and the log that goes into the turn record. Nothing here knows about the queue or the store.
import { spawn } from 'node:child_process';
import { config } from './config.mjs';
import { truncate } from './io.mjs';

const MAX_LOG_CHARS = 400_000;
const MAX_RAW_TAIL_LINES = 120;

function toolDetail(name, args = {}) {
  if (name === 'bash') return truncate(String(args.command ?? '').replace(/\s+/g, ' '), 120);
  if (typeof args.path === 'string') return args.path;
  if (typeof args.file === 'string') return args.file;
  if (typeof args.pattern === 'string') return args.pattern;
  return truncate(String(args.i ?? ''), 80);
}

function appendLast(list, text) {
  if (list.length === 0) list.push(text);
  else list[list.length - 1] += text;
}

export function runOmpAgent({ cwd, prompt, timeoutMs, onEvent, onSpawn }) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--mode', 'json',
      '--no-session',
      '--no-title',
      '--auto-approve',
      '--model', config.model,
      '--cwd', cwd,
      '--max-time', String(Math.max(60, Math.ceil(timeoutMs / 1000)))
    ];
    const child = spawn(config.ompBin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_NO_TITLE: '1' }
    });
    // The caller keeps the handle so a shutdown can signal the child and wait for it to be gone.
    if (typeof onSpawn === 'function') onSpawn(child);

    const state = {
      assistantTexts: [],
      tools: [],
      finalAnswer: '',
      stderr: '',
      rawLines: [],
      buffer: '',
      timedOut: false,
      spawnError: null
    };

    const timer = setTimeout(() => {
      state.timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    const handleEvent = (event) => {
      switch (event.type) {
        case 'message_update': {
          const update = event.assistantMessageEvent ?? {};
          if (update.type === 'text_delta') {
            const text = String(update.delta ?? '');
            if (text) appendLast(state.assistantTexts, text);
            onEvent({ type: 'delta', text });
          }
          break;
        }
        case 'tool_execution_start': {
          const detail = { name: event.toolName ?? 'tool', detail: toolDetail(event.toolName, event.args), ok: null };
          state.tools.push({ name: detail.name, detail: detail.detail, ok: null });
          onEvent({ type: 'tool', state: 'start', ...detail });
          break;
        }
        case 'tool_execution_end': {
          const name = event.toolName ?? 'tool';
          const entry = [...state.tools].reverse().find((tool) => tool.name === name && tool.ok === null);
          const ok = !event.error;
          if (entry) entry.ok = ok;
          onEvent({ type: 'tool', state: 'end', name, detail: entry?.detail ?? toolDetail(name, event.args), ok });
          break;
        }
        case 'agent_end': {
          const messages = Array.isArray(event.messages) ? event.messages : [];
          const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
          if (lastAssistant) {
            state.finalAnswer = (lastAssistant.content ?? [])
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
              .trim();
          }
          break;
        }
        default:
          break;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      state.buffer += chunk;
      let index = state.buffer.indexOf('\n');
      while (index >= 0) {
        const line = state.buffer.slice(0, index).trim();
        state.buffer = state.buffer.slice(index + 1);
        index = state.buffer.indexOf('\n');
        if (!line) continue;
        state.rawLines.push(line);
        if (state.rawLines.length > MAX_RAW_TAIL_LINES) state.rawLines.shift();
        if (line.startsWith('{')) {
          try {
            handleEvent(JSON.parse(line));
          } catch {
            // non JSON diagnostics stay in rawLines only
          }
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      state.stderr = truncate(`${state.stderr}${chunk}`, 20_000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      state.spawnError = String(error?.message ?? error);
      resolve({ ...state, code: null, ok: false });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ...state, code, ok: code === 0 && !state.spawnError && !state.timedOut });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

export function composeAgentLog({ prompt, run, answer }) {
  const parts = ['## Request sent to the agent', '', prompt.trim(), '', '## Tools used', ''];
  if (run.tools.length === 0) parts.push('(niciuna)', '');
  for (const [index, tool] of run.tools.entries()) {
    const mark = tool.ok === false ? '✗' : tool.ok === true ? '✓' : '…';
    parts.push(`${index + 1}. ${mark} ${tool.name} — ${tool.detail || '(no details)'}`);
  }
  parts.push('', '## Textul agentului', '');
  const narration = run.assistantTexts.join('\n\n').trim();
  parts.push(narration || '(the agent produced no narrative text outside tool calls)', '');
  if (answer && answer !== narration) parts.push('## Final reply', '', answer, '');
  if (run.stderr.trim()) parts.push('## Errors (stderr)', '', '```', truncate(run.stderr.trim(), 4_000), '```', '');
  if (!run.ok) {
    parts.push('## Last raw lines', '', '```json', run.rawLines.join('\n'), '```', '');
  }
  return truncate(parts.join('\n'), MAX_LOG_CHARS);
}
