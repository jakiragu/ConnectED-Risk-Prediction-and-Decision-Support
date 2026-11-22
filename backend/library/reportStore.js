import { DeleteObjectsCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from './client.js';

export const reportKey = ({ school_id, term_id, class_id, checkpoint, student_id, calculation_id }) =>
  `report-cards/${school_id}/${term_id}/${class_id}/${checkpoint}/${student_id}-${calculation_id}.pdf`;

export async function store(key, body) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.REPORT_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/pdf',
  }));
  return { bucket: process.env.REPORT_BUCKET, key };
}

/**
 * Removes every report-card PDF of a school, for good (schoolDeletion.js). The bucket keeps
 * versions, so each version and delete marker is removed by its id; deleting by key alone would
 * only hide the files. Works through them a thousand at a time until `until` (a clock time in
 * ms) and can be called again to carry on.
 * @returns {{ removed: number, done: boolean }}
 */
export async function purgeSchool(schoolId, until = Infinity) {
  const Bucket = process.env.REPORT_BUCKET;
  if (!Bucket) return { removed: 0, done: true };
  // The trailing slash matters: sch_a must not match sch_ab.
  const Prefix = `report-cards/${schoolId}/`;
  let removed = 0;
  for (;;) {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix, MaxKeys: 1000 }));
    const Objects = [...(page.Versions || []), ...(page.DeleteMarkers || [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    if (!Objects.length) return { removed, done: true };
    const res = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
    if (res.Errors?.length) throw Object.assign(new Error(`Could not remove ${res.Errors.length} report-card files`), { name: res.Errors[0].Code || 'DeleteFailed' });
    removed += Objects.length;
    if (Date.now() >= until) return { removed, done: false };
  }
}
