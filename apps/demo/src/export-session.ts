/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * Export a capture off the phone.
 *
 * Writes to the app's cache directory and hands it to the system share sheet,
 * rather than stuffing the JSON into `Share.share({ message })` — a few minutes
 * of notifications is comfortably megabytes, which the text share path does not
 * handle well.
 */

import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

export interface ExportResult {
  uri: string;
  bytes: number;
  shared: boolean;
}

function timestampSlug(): string {
  // 2026-07-31T14-05-22
  return new Date().toISOString().replace(/\..+$/, "").replace(/:/g, "-");
}

export async function exportCaptureJson(
  json: string,
  deviceName: string | null,
): Promise<ExportResult> {
  const safeName = (deviceName ?? "axs-device").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const filename = `${safeName}-${timestampSlug()}.json`;

  const directory = FileSystem.Paths.cache;
  const file = new FileSystem.File(directory, filename);

  if (file.exists) file.delete();
  file.create();
  file.write(json);

  const bytes = file.size ?? json.length;

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/json",
      dialogTitle: "Export AXS capture",
      UTI: "public.json",
    });
    return { uri: file.uri, bytes, shared: true };
  }

  return { uri: file.uri, bytes, shared: false };
}
