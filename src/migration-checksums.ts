export interface MigrationChecksumEntry {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export const MIGRATION_CHECKSUM_MANIFEST = Object.freeze([
  { version: 1, name: "initial_scoped_store", checksum: "b4f963273dabb3cf23a6c096c2b2e61f793e57ae05a1783ae98af1db71dc287b" },
  { version: 2, name: "credential_authority", checksum: "9c793825d13e0b1a9ac7bea8ffd5dc275c94a13062c708c1c030835c56c99d00" },
  { version: 3, name: "coordination_protocol", checksum: "5c84ed883d65a136a7a75adadd2acb31cc5c2e499ab9f92aefc73b35b3487c45" },
  { version: 4, name: "seat_attach_credentials", checksum: "015311cd578e5ea887051b3b5fef062f9157af83d9c18817e8f09b09b1c5a40f" },
  { version: 5, name: "owner_enrollment_and_cube_creation", checksum: "aae82cd4d7de4508f61acafb9a1b6d710b93b0694f0e17792d1e40d85fe2c66f" },
  { version: 6, name: "seat_reattach_bindings", checksum: "71928794fc3012750200611b712aa31aa3c9cb7652a38fb2c2f0390b528e2ac5" },
  { version: 7, name: "role_management_foundation", checksum: "f808335d9f4c15e831abda830a9a8c524f9e716be91f630298f4418a3a5a6d1b" },
  { version: 8, name: "cube_scoped_invitations", checksum: "b5c38b3c3df24063828687b246318c9f35b846fb28064b847dc9929d88f1a025" },
  { version: 9, name: "digest_correlated_seat_attach", checksum: "0c35559ed0cf459e4859dc02af9c82be00cfa9e0bf982d23b73744893cc7aecb" },
  { version: 10, name: "cube_message_taxonomy", checksum: "a893207fc4be385132275ac2378d282eb63c68a9f7660e8e86cb5304ab818534" },
  { version: 11, name: "fleet_liveness", checksum: "da687141abc57f27ff87dcd9c38fdd6a15028c0c503407f793f3969d8989eaee" },
  { version: 12, name: "drone_session_supersession", checksum: "5ce665dc6317a34014d6ee7bc537c43d1a6ed578ac910159edda5c7e78df0536" },
  { version: 13, name: "non_expiring_drone_sessions", checksum: "e8f007a20f5816357c83856682bef4acc9e6789514a74295b23b16186a82ea87" },
  { version: 14, name: "drone_runtime_metadata", checksum: "5e78f86534cb1937add1a8682b181c3d4f67510ca332d4034c6d38f4288c6de5" },
  { version: 15, name: "repository_associated_cube_creation", checksum: "679caa4baa9df1fad26b65ec3dcdbd809e825253821a207a0a4a7b415996d6bd" },
  { version: 16, name: "remove_scoped_invitations", checksum: "701e1a8ff131f21d724e96bc21af15ac8650c5b16b83720938e4e2dc10e2df83" },
  { version: 17, name: "invitation_client_names", checksum: "dd997a65f9d2c740974153c0458703bd8f5e41843927e9444ff71fe9910da4f7" },
  { version: 18, name: "shared_cube_templates", checksum: "8ee4ca35cc62fb00426a3d05ae490435d4f22a5965ef461c37fd0c8a8a8cab23" },
  { version: 19, name: "deleted_cube_tombstones", checksum: "8f13c05d7083b33cfef77d82b347a1eec48b022fe3ab4218c05a88280ea147c0" },
  { version: 20, name: "widen_repository_cube_associations", checksum: "104920d1cf26b3d721c4b16ecfa8028cbdd6628f9f9a375aa2d3f1e2eeb1b8ff" },
  { version: 21, name: "durable_activity_wake_attempts", checksum: "5fb4e3e4cfb8e69a3577bea9efadf887bd3dfd81e107e417e338efb4b6d7fe47" },
  { version: 22, name: "remove_recovery_credentials", checksum: "b973a460e5e88f2cf9f9a323b501b5b6c0e549b7aaf6d4cc391fbcad59266493" },
] satisfies readonly MigrationChecksumEntry[]);
