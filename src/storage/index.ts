import { IStorageRepository } from './interfaces';
import { InMemoryStorageRepository } from './inMemoryStorage';
import { SqliteStorageRepository } from './sqliteStorage';

export * from './interfaces';
export * from './inMemoryStorage';
export * from './sqliteStorage';

// Factory for Storage Adapter - Defaulting to Persistent SQLite for Production & VPS
let activeStorageInstance: IStorageRepository | null = null;

export function getStorageRepository(customDbPath?: string): IStorageRepository {
  if (!activeStorageInstance) {
    activeStorageInstance = new SqliteStorageRepository(customDbPath);
  }
  return activeStorageInstance;
}
