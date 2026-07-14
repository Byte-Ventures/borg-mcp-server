export interface PackedArtifactReport {
  readonly name: string;
  readonly version: string;
  readonly fileCount: number;
  readonly packedBytes: number;
  readonly unpackedBytes: number;
  readonly integrity: string;
}

export function verifyPackedArtifact(tarballPath: string): Promise<PackedArtifactReport>;
