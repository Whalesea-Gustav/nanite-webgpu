import { meshopt_Meshlets } from '../meshPreprocessing/createMeshlets.ts';
import { NaniteLODTree } from './naniteLODTree.ts';

export interface Scene {
  naniteObject: NaniteLODTree;

  // meshes for debug
  mesh: Mesh;
  meshlets: MeshletRenderPckg;
  meshoptimizerLODs: Mesh[];
  meshoptimizerMeshletLODs: MeshletRenderPckg[];
}

/** Used only in debug */
export interface Mesh {
  vertexCount: number;
  triangleCount: number;

  // GPU buffers
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
}

/** Used only in debug */
export type MeshletRenderPckg = meshopt_Meshlets & {
  // GPU buffers
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
};
