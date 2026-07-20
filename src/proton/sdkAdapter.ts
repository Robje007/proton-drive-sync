/**
 * Compatibility boundary for the official SDK.
 *
 * SDK 0.19 returns NodeEntity directly and wraps encrypted fields in Result,
 * while the original application used the pre-0.19 result-shaped API. Keeping
 * that translation here avoids spreading SDK internals throughout the sync
 * engine and gives future SDK upgrades one small, testable boundary.
 */

import type { ProtonDriveClient as SdkClient } from '@protontech/drive-sdk';
import type { DriveEvent, NodeData, NodeResult, ProtonDriveClient, RevisionData } from './types.js';

type SdkNode = Awaited<ReturnType<SdkClient['getNode']>>;

function unwrapResult<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function adaptNode(node: SdkNode): NodeData {
  const revision = node.activeRevision?.ok ? node.activeRevision.value : undefined;
  const activeRevision: RevisionData | undefined = revision
    ? {
        uid: revision.uid,
        state: revision.state,
        creationTime: revision.creationTime,
        contentAuthor: revision.contentAuthor,
        storageSize: revision.storageSize,
        claimedSize: revision.claimedSize,
        claimedModificationTime: revision.claimedModificationTime,
        claimedDigests: revision.claimedDigests?.sha1
          ? { sha1: revision.claimedDigests.sha1 }
          : undefined,
        claimedAdditionalMetadata: revision.claimedAdditionalMetadata,
      }
    : undefined;

  return {
    uid: node.uid,
    parentUid: node.parentUid,
    name: unwrapResult(node.name),
    type: node.type,
    mediaType: node.mediaType,
    isShared: node.isShared,
    isSharedPublicly: node.isSharedPublicly,
    creationTime: node.creationTime,
    trashTime: node.trashTime,
    totalStorageSize: node.totalStorageSize,
    treeEventScopeId: node.treeEventScopeId,
    activeRevision,
    size: activeRevision?.claimedSize,
    updatedAt: activeRevision?.claimedModificationTime ?? node.modificationTime,
  };
}

export function adaptSdkClient(client: SdkClient): ProtonDriveClient {
  return {
    async *iterateFolderChildren(folderUid) {
      for await (const node of client.iterateFolderChildren(folderUid)) {
        try {
          yield { ok: true, value: adaptNode(node) };
        } catch (error) {
          yield { ok: false, error };
        }
      }
    },

    async getMyFilesRootFolder() {
      try {
        return { ok: true, value: adaptNode(await client.getMyFilesRootFolder()) };
      } catch (error) {
        return { ok: false, error };
      }
    },

    async getNode(nodeUid) {
      return adaptNode(await client.getNode(nodeUid));
    },

    getFileDownloader(nodeUid, signal) {
      return client.getFileDownloader(nodeUid, signal);
    },

    subscribeToTreeEvents(treeEventScopeId, callback) {
      return client.subscribeToTreeEvents(treeEventScopeId, (event) =>
        callback(event as DriveEvent)
      );
    },

    async createFolder(parentNodeUid, name, modificationTime) {
      try {
        return {
          ok: true,
          value: adaptNode(await client.createFolder(parentNodeUid, name, modificationTime)),
        };
      } catch (error) {
        return { ok: false, error };
      }
    },

    getFileUploader(parentFolderUid, name, metadata, signal) {
      return client.getFileUploader(parentFolderUid, name, metadata, signal);
    },

    getFileRevisionUploader(nodeUid, metadata, signal) {
      return client.getFileRevisionUploader(nodeUid, metadata, signal);
    },

    trashNodes(nodeUids) {
      return client.trashNodes(nodeUids);
    },

    deleteNodes(nodeUids) {
      return client.deleteNodes(nodeUids);
    },

    async renameNode(nodeUid, newName): Promise<NodeResult> {
      try {
        return { ok: true, value: adaptNode(await client.renameNode(nodeUid, newName)) };
      } catch (error) {
        return { ok: false, error };
      }
    },

    moveNodes(nodeUids, newParentNodeUid, signal) {
      return client.moveNodes(nodeUids, newParentNodeUid, signal);
    },
  };
}
