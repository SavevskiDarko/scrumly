import { useEffect, useState } from 'react'
import { sync, type SyncStatus } from './engine'

export function useSync(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(sync.status)
  useEffect(() => sync.subscribe(setStatus), [])
  return status
}
