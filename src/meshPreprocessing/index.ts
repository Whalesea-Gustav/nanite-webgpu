import { NaniteLODTree } from '../scene/types.ts';
import { createGPU_IndexBuffer } from '../utils/index.ts';
import { createMeshlets, splitIndicesPerMeshlets } from './createMeshlets.ts';
import {
  listAllEdges,
  findBoundaryEdges,
  Edge,
  findAdjacentMeshlets,
} from './edgesUtils.ts';
import { partitionGraph } from './partitionGraph.ts';
import { simplifyMesh } from './simplifyMesh.ts';

/** We half triangle count each time. Each meshlet is 124 triangles.
 * $2^{MAX_LODS}*124$. E.g. MAX_LODS=15 gives 4M. Vertices above would
 * lead to many top-level tree nodes. Suboptimal, but not incorrect.
 */
const MAX_LODS = 15;

/** Reduce triangle count per each level. */
const DECIMATE_FACTOR = 2;
const TARGET_SIMPLIFY_ERROR = 0.05;

/** Meshlet when constructing the tree */
export interface MeshletWIP {
  lodLevel: number;
  indices: Uint32Array;
  boundaryEdges: Edge[];
  /** Infinity for top tree level */
  parentError: number;
  maxSiblingsError: number;
  createdFrom: MeshletWIP[];
  indexBuffer: GPUBuffer | undefined; // TODO remove?
}

export async function createNaniteMeshlets(
  vertices: Float32Array,
  indices: Uint32Array
): Promise<MeshletWIP[]> {
  const allMeshlets: MeshletWIP[] = [];
  let lodLevel = 0;
  const bottomMeshlets = await splitIntoMeshlets(indices, 0.0);
  let currentMeshlets = bottomMeshlets;
  lodLevel += 1;

  for (; lodLevel < MAX_LODS + 1; lodLevel++) {
    // prettier-ignore
    // console.log(`LOD ${lodLevel}: Starting with ${currentMeshlets.length} meshlets`);

    // 1. group meshlets into groups of 4
    // e.g. 33 meshlets is 9 groups (last one is 1 meshlet)
    const GROUP_SIZE = 4;
    const nparts = Math.ceil(currentMeshlets.length / GROUP_SIZE);
    let partitioned = [currentMeshlets];
    if (currentMeshlets.length > GROUP_SIZE) {
      const adjacency = findAdjacentMeshlets(
        currentMeshlets.map((m) => m.boundaryEdges)
      );
      // each part is 4 meshlets
      const meshletIdxPerPart = await partitionGraph(adjacency, nparts, {});
      partitioned = meshletIdxPerPart.map((indices) => {
        return indices.map((i) => currentMeshlets[i]);
      });
    }

    // 2. for each group of 4 meshlets
    const newlyCreatedMeshlets: MeshletWIP[] = [];
    for (const meshletGroup of partitioned) {
      // 2.1 merge triangles from all meshlets in the group
      const megaMeshlet: Uint32Array = mergeMeshlets(...meshletGroup);

      // 2.2 simplify to remove not needed edges/vertices in the middle
      const targetIndexCount = Math.floor(megaMeshlet.length / DECIMATE_FACTOR);
      const simplifiedMesh = await simplifyMesh(vertices, megaMeshlet, {
        targetIndexCount,
        targetError: TARGET_SIMPLIFY_ERROR,
        lockBorders: true, // important!
      });
      const errorNow = simplifiedMesh.error * simplifiedMesh.errorScale;
      const childrenError = Math.max(
        ...meshletGroup.map((m) => m.maxSiblingsError)
      );
      const totalError = errorNow + childrenError;

      // 2.3 split into new meshlets
      let newMeshlets: MeshletWIP[];
      if (partitioned.length === 1) {
        // this happens on last iteration, when < 4 meshlets
        // prettier-ignore
        const rootMeshlet = createMeshletWip(simplifiedMesh.indexBuffer, totalError);
        newMeshlets = [rootMeshlet];
      } else {
        // prettier-ignore
        newMeshlets = await splitIntoMeshlets(simplifiedMesh.indexBuffer, totalError);
      }

      meshletGroup.forEach((m) => {
        m.parentError = totalError;
        m.maxSiblingsError = childrenError;
        newMeshlets.forEach((m2) => {
          m2.createdFrom.push(m);
        });
      });
      newlyCreatedMeshlets.push(...newMeshlets);
    }

    currentMeshlets = newlyCreatedMeshlets;
    if (currentMeshlets.length < 2) {
      console.log(`Did not fill all ${MAX_LODS} LOD levels, mesh is too small`);
      break;
    }
  }

  console.log('[Nanite] All meshlets:', allMeshlets);
  console.log('[Nanite] Top level meshlets:', currentMeshlets);
  console.log(
    `[Nanite] Created LOD levels: ${lodLevel} (total ${allMeshlets.length} meshlets from ${bottomMeshlets.length} bottom level meshlets)`
  );

  if (currentMeshlets.length !== 1) {
    // It's ok to increase $MAX_LODS, just make sure you know what you are doing.
    throw new Error(
      `Nanite created ${lodLevel} LOD levels and would still require more? How big is your mesh?! Increase MAX_LODS (currrently ${MAX_LODS}) or reconsider mesh.`
    );
  }

  return allMeshlets;

  /////////////
  /// Utils

  async function splitIntoMeshlets(
    indices: Uint32Array,
    simplificationError: number
  ) {
    const meshletsOpt = await createMeshlets(vertices, indices, {});
    // during init: create tons of small meshlets
    // during iter: split simplified mesh into 2 meshlets
    const meshletsIndices = splitIndicesPerMeshlets(meshletsOpt);

    const meshlets: MeshletWIP[] = meshletsIndices.map((indices) =>
      createMeshletWip(indices, simplificationError)
    );

    allMeshlets.push(...meshlets);
    return meshlets;
  }

  function createMeshletWip(
    indices: Uint32Array,
    simplificationError: number
  ): MeshletWIP {
    const edges = listAllEdges(indices);
    const boundaryEdges = findBoundaryEdges(edges);
    return {
      indices,
      boundaryEdges,
      // maxSiblingsError will temporarly hold the error till
      // we determine siblings in next iter
      maxSiblingsError: simplificationError,
      parentError: Infinity,
      lodLevel,
      createdFrom: [],
      indexBuffer: undefined,
    };
  }
}

function mergeMeshlets(...meshletGroup: MeshletWIP[]): Uint32Array {
  const len = meshletGroup.reduce((acc, m) => acc + m.indices.length, 0);
  const result = new Uint32Array(len);

  // copy all indices into a single Uint32Array one by one
  let nextIdx = 0;
  meshletGroup.forEach((m) => {
    m.indices.forEach((idx) => {
      result[nextIdx] = idx;
      nextIdx += 1;
    });
  });

  return result;
}

export function createNaniteLODTree(
  device: GPUDevice,
  vertexBuffer: GPUBuffer,
  allMeshlets: MeshletWIP[]
): NaniteLODTree {
  // const lodLevels = 1 + Math.max(...allMeshlets.map((m) => m.lodLevel));
  // const naniteDbgLODs: Array<NaniteMeshletTreeNode[]> = [];

  /* // Code below used with optimized NaniteTreeNode
  for (let i = 0; i < lodLevels; i++) {
    const nodes: NaniteMeshletTreeNode[] = [];
    naniteDbgLODs.push(nodes);
    const meshlets = allMeshlets.filter((m) => m.lodLevel === i);
    meshlets.forEach((m, j) => {
      const indexBuffer = createGPU_IndexBuffer(
        device,
        `nanite-lod-${i}-meshlet-${j}`,
        m.indices
      );
      nodes.push({
        triangleCount: getTriangleCount(m.indices),
        indexBuffer,
      });
    });
  }
  */
  allMeshlets.forEach((m, j) => {
    const indexBuffer = createGPU_IndexBuffer(
      device,
      `nanite-meshlet-${j}`,
      m.indices
    );
    m.indexBuffer = indexBuffer;
  });

  return { vertexBuffer, naniteDbgLODs: allMeshlets };
}
