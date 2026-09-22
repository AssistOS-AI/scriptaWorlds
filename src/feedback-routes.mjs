// The reader-feedback surface of the host (`docs/contracts.md` §8.7): the frozen targets a reader saw,
// the responses, the reader identities, the dataset, the summary, the comparison of two accepted
// versions and the revision a selection of feedback becomes. It lives in its own module so the router
// stays a readable sequence of routes and inside its size gate. The invariants:
//
//  - every route here reads or writes only the feedback of one book, which lives in the workspace of
//    §8.1 and never inside `universes/`;
//  - the refusal of a comparison, the numbers of a comparison, the dataset and the summary are produced
//    by their own modules: this module validates the request, calls them and sends what they answer;
//  - an approval is the decision of §8.4 on the proposal, recorded through the same route as every
//    other proposal, and asking for a revision hands the request it produced to the existing rewrite
//    path rather than writing a chapter here;
//  - `targets`, `export`, `summary`, `comparison` and `revisions` are the reserved segments of the
//    feedback route: a response whose identifier is one of those words is not readable as a response.
import { config } from './config.mjs';
import { UniverseError } from './errors.mjs';
import { buildFeedbackComparison } from './feedback-comparison.mjs';
import { listFeedback, readFeedback, recordReaderDeletion, submitFeedback, withdrawFeedback } from './feedback-entries.mjs';
import { feedbackExportDownload } from './feedback-export.mjs';
import { createFeedbackReader, listFeedbackReaders, readFeedbackReader, renameFeedbackReader } from './feedback-readers.mjs';
import { selectFeedbackForRevision, startFeedbackRevision } from './feedback-revision.mjs';
import { buildFeedbackSummary } from './feedback-summary.mjs';
import { createFeedbackTarget, readFeedbackTarget } from './feedback-targets.mjs';
import { readJsonBody, sendDownload, sendJson } from './http.mjs';

/**
 * Answers `sub` of one universe's feedback surface: `feedback` and `readers`, the two segments this
 * module owns. It answers `true` when it handled the request and `false` when the segment is another
 * area of the host, which the router then answers itself.
 */
export async function handleFeedbackRoutes({ req, res, segments, id, sub, extra, url }) {
  if (sub === 'feedback') {
    // The team's reading responses (`docs/contracts.md` §8.7): a target is the accepted version of the
    // book frozen outside `universes/`, an entry is one reader's answer to it, never rewritten except
    // by a withdrawal, and `targets`, `export`, `summary`, `comparison` and `revisions` are the
    // reserved segments this route answers itself.
    if (extra === 'export' || extra === 'summary') {
      if (req.method !== 'GET') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      const dataset = extra === 'export' ? await feedbackExportDownload(id) : null;
      if (dataset) sendDownload(res, dataset.name, dataset.body);
      else sendJson(res, 200, { summary: await buildFeedbackSummary(id) });
      return true;
    }
    if (extra === undefined) {
      if (req.method === 'GET') {
        sendJson(res, 200, await listFeedback(id));
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const written = await submitFeedback({
          universeId: id,
          targetId: body.targetId ?? null,
          readerId: body.readerId ?? null,
          feedbackId: body.feedbackId ?? null,
          answers: body.answers ?? [],
          comments: body.comments ?? [],
          conditions: body.conditions ?? null,
          revisionOf: body.revision_of ?? null,
          readerKind: body.readerKind ?? null,
          questionnaireVersion: body.questionnaireVersion ?? null
        });
        console.log(`[feedback] ${written.feedback.feedback_id} ${written.feedback.reader_kind} for ${id}${written.deduplicated ? ' (deduplicated)' : ''}`);
        sendJson(res, written.deduplicated ? 200 : 201, { feedback: written.feedback, deduplicated: written.deduplicated });
        return true;
      }
      throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    }
    if (extra === 'targets') {
      if (segments[5] !== undefined) {
        if (req.method !== 'GET') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
        sendJson(res, 200, { target: await readFeedbackTarget(id, segments[5]) });
        return true;
      }
      if (req.method !== 'POST') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      const body = await readJsonBody(req, config.maxBodyBytes);
      const frozen = await createFeedbackTarget({
        universeId: id,
        scope: body.scope ?? null,
        runId: body.runId ?? null,
        note: body.note ?? null,
        findingIds: body.findingIds ?? []
      });
      console.log(`[feedback] target ${frozen.target.target_id} ${frozen.target.scope.kind} of ${frozen.target.scope.chapters.length} chapter(s) for ${id}${frozen.deduplicated ? ' (already frozen)' : ''}`);
      sendJson(res, frozen.deduplicated ? 200 : 201, { target: frozen.target, deduplicated: frozen.deduplicated });
      return true;
    }
    if (extra === 'comparison') {
      // What two accepted versions of this book were said about one question: the rule of the summary
      // decides whether the responses support the comparison at all, and the two sides are reported
      // with the versions and the identities behind them instead of a single number.
      if (segments[5] !== undefined) throw new UniverseError('NOT_FOUND', 'Unknown route.', 404);
      if (req.method !== 'GET') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      const comparison = await buildFeedbackComparison(id, {
        questionId: url.searchParams.get('question'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to')
      });
      sendJson(res, 200, { comparison });
      return true;
    }
    if (extra === 'revisions') {
      // Selecting responses becomes a proposal; approving it is the decision of §8.4 recorded on the
      // proposal itself, and asking for the revision hands the request it produced to the existing
      // rewrite path, which performs it.
      if (segments[5] === 'rewrite') {
        if (req.method !== 'POST') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
        const body = await readJsonBody(req, config.maxBodyBytes);
        const asked = await startFeedbackRevision({
          universeId: id,
          proposal: body.proposal ?? null,
          approval: body.approval ?? null,
          dropLater: body.dropLater === true
        });
        console.log(`[feedback] revision of chapter ${asked.request.chapter_number} requested for ${id} from ${asked.request.feedback_ids.length} response(s), as turn ${asked.job.turnNumber}`);
        sendJson(res, 202, asked);
        return true;
      }
      if (segments[5] !== undefined) throw new UniverseError('NOT_FOUND', 'Unknown route.', 404);
      if (req.method !== 'POST') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      const body = await readJsonBody(req, config.maxBodyBytes);
      const proposal = await selectFeedbackForRevision({
        universeId: id,
        selections: body.selections ?? [],
        chapterNumber: body.chapterNumber ?? null,
        note: body.note ?? null,
        preserve: body.preserve ?? []
      });
      console.log(`[feedback] revision proposal for ${id}: ${proposal.items.length} selected response(s) on ${proposal.version.slice(0, 18)}…, chapter ${proposal.chapter_number}`);
      sendJson(res, 201, { proposal });
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { feedback: await readFeedback(id, extra) });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req, config.maxBodyBytes).catch(() => ({}));
      if (body.action === 'withdraw') {
        const withdrawn = await withdrawFeedback({ universeId: id, feedbackId: extra });
        console.log(`[feedback] ${withdrawn.feedback_id} withdrawn by its reader`);
        sendJson(res, 200, { feedback: withdrawn });
        return true;
      }
      throw new UniverseError('INVALID_FEEDBACK', 'Unknown feedback action (withdraw); a correction is a new submission with `revision_of`.', 400);
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  if (sub === 'readers') {
    // The stable identities of the team's readers: created once, renamed without losing attribution,
    // and deleted only through a request that is itself recorded as an entry.
    if (extra === undefined) {
      if (req.method === 'GET') {
        sendJson(res, 200, { readers: await listFeedbackReaders(id) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const reader = await createFeedbackReader({ universeId: id, displayName: body.displayName, kind: body.kind ?? null });
        console.log(`[feedback] reader ${reader.reader_id} (${reader.display_name}, ${reader.kind}) for ${id}`);
        sendJson(res, 201, { reader });
        return true;
      }
      throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { reader: await readFeedbackReader(id, extra) });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req, config.maxBodyBytes).catch(() => ({}));
      if (body.action === 'delete') {
        const deleted = await recordReaderDeletion({ universeId: id, readerId: extra, note: body.note ?? null });
        console.log(`[feedback] reader ${deleted.reader.reader_id} asked to be deleted (${deleted.entry.feedback_id})`);
        sendJson(res, deleted.deduplicated ? 200 : 201, { reader: deleted.reader, entry: deleted.entry, deduplicated: deleted.deduplicated });
        return true;
      }
      if (typeof body.displayName === 'string') {
        sendJson(res, 200, { reader: await renameFeedbackReader({ universeId: id, readerId: extra, displayName: body.displayName }) });
        return true;
      }
      throw new UniverseError('INVALID_FEEDBACK', 'Unknown reader action (delete, or a displayName to rename).', 400);
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }
  return false;
}
