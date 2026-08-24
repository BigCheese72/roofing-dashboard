// AI training-label purge helpers — the DELETION CASCADE side of the
// ai_training_labels collection (see js/ailabels.js for the write path and
// "AI training labels" in DEV_NOTES.md / DATA_MODEL.md for the design).
//
// WHY THIS EXISTS: label records reference customer roof photos. Photos are
// customer property — when a building (or a work order / photo) is deleted,
// its label records must be purgeable too, and firestore.rules gives clients
// NO delete path on this collection (read/update/delete are all denied), so
// the cascade has to live server-side, under the Admin SDK.
//
// WIRED TODAY: admin.js's delete_building calls purgeLabelsForBuilding()
// — the only hard-delete path for a building.
//
// DOCUMENTED HOOKS (for the owners of those files to wire when ready —
// this session deliberately doesn't touch them):
// - Work-order delete (client-side today, workorders collection is open):
//   the tech-facing Delete button removes the workorder doc directly, so it
//   CANNOT cascade here by itself. When that flow gets a server component
//   (or photos.js's delete action is invoked for its photos), call
//   purgeLabelsForWorkOrder(db, workOrderId).
// - Single-photo delete (netlify/functions/photos.js "delete" action):
//   call purgeLabelsForPhoto(db, workOrderId, photoIndex) alongside the
//   Storage delete. Until wired, an orphaned label row points at a photo
//   that no longer resolves — harmless to training (it just gets skipped at
//   export time) but should still be cleaned up eventually.
const AI_LABELS_COLLECTION = "ai_training_labels";

// Firestore batches cap at 500 ops; chunk accordingly. Returns the number
// of label docs deleted. A query/delete failure propagates to the caller —
// delete_building treats a failed cascade as a failed delete (it runs the
// purge BEFORE deleting the building doc, so a retry still finds the rows).
async function purgeLabelsWhere(db, field, value) {
  const snap = await db.collection(AI_LABELS_COLLECTION).where(field, "==", value).get();
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

async function purgeLabelsForBuilding(db, buildingId) {
  return purgeLabelsWhere(db, "buildingId", buildingId);
}

async function purgeLabelsForWorkOrder(db, workOrderId) {
  return purgeLabelsWhere(db, "workOrderId", workOrderId);
}

// A photo is identified by its owning work order + index (the same pair
// netlify/functions/photos.js builds Storage paths from) — matches label
// docs whose photo reference points at exactly that photo, either kind
// ("storage" or "workorder_embedded"; a CompanyCam photo isn't deletable
// through this app at all, so there's no cascade for that kind).
async function purgeLabelsForPhoto(db, workOrderId, photoIndex) {
  const snap = await db.collection(AI_LABELS_COLLECTION)
    .where("photo.workOrderId", "==", workOrderId)
    .where("photo.photoIndex", "==", photoIndex)
    .get();
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

module.exports = { purgeLabelsForBuilding, purgeLabelsForWorkOrder, purgeLabelsForPhoto, AI_LABELS_COLLECTION };
