// The declared scope of a packet, and what it obliges (no external dependencies).
//
// `scope.kind` is the declared honesty of the packet, so it is both validated as
// a shape and enforced against the entries the packet actually carries:
//
//   - `complete` — every chapter from 1 to the last accepted one, the state
//     containers `canon`, `threads` and `atlas`, and no declared omission;
//   - `partial` — the chapters it contains, with every absent chapter of the
//     accepted book declared in `scope.omitted`, where a declared omission is
//     honest and an undeclared interior gap is not;
//   - `textual_only` — chapter prose and no state container at all.
//
// What is refused is always the mismatch, never the omission itself: a partial
// packet that declares what it left out is a limited review, while a complete
// packet with an interior gap is a lie about the book it claims to hold.

import { isPlainObject } from './json-spans.mjs';

export const REQUIRED_STATE_ROLES = ['canon', 'threads', 'atlas'];

const SCOPE_KINDS = new Set(['complete', 'partial', 'textual_only']);

// Validate the declared scope object itself: kind, chapter lists and omissions.
export function validateDeclaredScope(errors, scope, fail) {
  if (!isPlainObject(scope)) {
    fail('INVALID_MANIFEST', 'manifest.scope must be an object');
    return null;
  }
  if (!SCOPE_KINDS.has(scope.kind)) {
    fail(
      'INVALID_MANIFEST',
      `manifest.scope.kind must be one of ${[...SCOPE_KINDS].join(', ')}, got ${JSON.stringify(scope.kind)}`,
    );
    return scope;
  }
  if (!Array.isArray(scope.chapters)) {
    fail('INVALID_MANIFEST', 'manifest.scope.chapters must be an array of chapter numbers');
  } else if (scope.chapters.some((number) => !Number.isInteger(number) || number < 1)) {
    fail('INVALID_MANIFEST', 'manifest.scope.chapters must contain positive integer chapter numbers');
  } else if (new Set(scope.chapters).size !== scope.chapters.length) {
    fail('INVALID_MANIFEST', 'manifest.scope.chapters must not repeat a chapter number');
  }
  if (scope.omitted !== undefined) {
    if (!Array.isArray(scope.omitted)) {
      fail('INVALID_MANIFEST', 'manifest.scope.omitted must be an array of chapter numbers');
    } else if (scope.omitted.some((number) => !Number.isInteger(number) || number < 1)) {
      fail('INVALID_MANIFEST', 'manifest.scope.omitted must contain positive integer chapter numbers');
    }
  } else if (scope.kind === 'partial') {
    fail('INVALID_MANIFEST', 'manifest.scope.omitted is required when scope.kind is "partial"');
  }
  if (scope.note !== undefined && typeof scope.note !== 'string') {
    fail('INVALID_MANIFEST', 'manifest.scope.note must be a string when present');
  }
  return scope;
}

// Enforce the declared scope against the chapter and role inventory the packet
// carries. `fail(code, message)` collects a coded refusal.
export function enforceScope(scope, lastAccepted, entries, fail) {
  const roles = new Set(entries.map((entry) => entry.role));
  const present = new Set(
    entries.filter((entry) => entry.role === 'chapter').map((entry) => entry.chapter),
  );
  const declared = Array.isArray(scope.chapters) ? scope.chapters : [];
  const omitted = Array.isArray(scope.omitted) ? scope.omitted : [];

  for (const number of declared) {
    if (!present.has(number)) {
      fail(
        'SCOPE_INCOMPLETE',
        `manifest.scope.chapters declares chapter ${number}, which this packet does not contain`,
      );
    }
  }
  // A packet that carries prose the scope does not declare cannot be reported as
  // reviewed: text nobody counted would silently become context.
  if (scope.kind !== 'textual_only' || declared.length > 0) {
    for (const number of present) {
      if (!declared.includes(number)) {
        fail(
          'SCOPE_INCONSISTENT',
          `this packet contains chapter ${number} but manifest.scope.chapters does not declare it`,
        );
      }
    }
  }
  for (const number of omitted) {
    if (present.has(number)) {
      fail(
        'SCOPE_INCONSISTENT',
        `manifest.scope.omitted declares chapter ${number}, which this packet contains`,
      );
    }
    if (number > lastAccepted) {
      fail(
        'INVALID_MANIFEST',
        `manifest.scope.omitted declares chapter ${number}, but book.last_accepted_chapter is ${lastAccepted}: ` +
          'only a chapter of the accepted book can be left out',
      );
    }
  }

  const missing = [];
  for (let number = 1; number <= lastAccepted; number += 1) {
    if (!present.has(number)) missing.push(number);
  }

  if (scope.kind === 'complete') {
    for (const number of missing) {
      fail(
        'SCOPE_INCOMPLETE',
        `manifest.scope.kind "complete" omits the interior chapter ${number} of the ` +
          `${lastAccepted} accepted chapter(s)`,
      );
    }
    for (const role of REQUIRED_STATE_ROLES) {
      if (!roles.has(role)) {
        fail('SCOPE_INCOMPLETE', `manifest.scope.kind "complete" omits the required "${role}" role`);
      }
    }
    if (omitted.length > 0) {
      fail('SCOPE_INCONSISTENT', 'manifest.scope.kind "complete" declares omissions in scope.omitted');
    }
  } else if (scope.kind === 'partial') {
    if (declared.length === 0) {
      fail('SCOPE_INCOMPLETE', 'manifest.scope.kind "partial" contains no chapter prose');
    }
    for (const number of missing) {
      if (!omitted.includes(number)) {
        fail(
          'SCOPE_INCONSISTENT',
          `manifest.scope.kind "partial" omits chapter ${number} without declaring it in scope.omitted`,
        );
      }
    }
  } else if (scope.kind === 'textual_only') {
    if (declared.length === 0) {
      fail('SCOPE_INCOMPLETE', 'manifest.scope.kind "textual_only" contains no chapter prose');
    }
    for (const role of REQUIRED_STATE_ROLES) {
      if (roles.has(role)) {
        fail(
          'SCOPE_INCONSISTENT',
          `manifest.scope.kind "textual_only" carries prose alone but declares the "${role}" role`,
        );
      }
    }
  }
}
