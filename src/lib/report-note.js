import { createHash } from 'node:crypto';
import { decisionReportText } from './recommendation-decision.js';

// Report copies are explicit snapshots. Working notes remain internal once reviewed.
export function reportNoteDraft(rec) {
  const decision=rec.review_decision;
  return {
    title: decision?.title?.trim() || (decision?.change?.trim() ? decision.change.trim().slice(0,120) : (rec.title || '').replace(/^Invisible for:?/i,'Review visibility for:')),
    notes: decision?.stage ? decisionReportText(decision).trim() : (rec.notes || '').trim()
  };
}
export function reportNotePreview(rec, saved=null) {
  const proposed=reportNoteDraft(rec);
  const current=saved ? {title:saved.title,notes:saved.notes} : null;
  return {current,proposed,changed:!!current && (current.title!==proposed.title || current.notes!==proposed.notes),
    canInclude:!!proposed.notes && proposed.notes.length<=12000,
    version:createHash('sha256').update(JSON.stringify([rec.id,rec.project_id,current,proposed])).digest('hex')};
}
