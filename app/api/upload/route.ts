import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { UploadedFile } from '@/lib/types';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const entries = form.getAll('files');
    if (!entries || entries.length === 0) {
      return NextResponse.json({ ok: false, error: 'no files' }, { status: 400 });
    }

    const uploadRoot = path.join(process.cwd(), 'uploads');
    await fs.mkdir(uploadRoot, { recursive: true });

    const saved: UploadedFile[] = [];

    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      const file = entry as File;
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const id = uuidv4().slice(0, 8);
      const relPath = path.join('uploads', `${stamp}_${id}_${safeName}`);
      const absPath = path.join(process.cwd(), relPath);
      await fs.writeFile(absPath, buffer);
      saved.push({ filename: file.name, path: `/${relPath}`, mime: file.type || undefined, size: buffer.length });
    }

    return NextResponse.json({ ok: true, files: saved });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message || 'upload error' }, { status: 500 });
  }
}