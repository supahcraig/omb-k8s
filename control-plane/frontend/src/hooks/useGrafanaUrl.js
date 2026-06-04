import { useEffect, useState } from 'react'
import { getGrafanaUrl } from '../api.js'

let _cached = undefined  // module-level cache: undefined=not fetched, null=unavailable, string=url

export default function useGrafanaUrl() {
  const [url, setUrl] = useState(_cached !== undefined ? _cached : null)

  useEffect(() => {
    if (_cached !== undefined) {
      setUrl(_cached)
      return
    }
    getGrafanaUrl()
      .then(data => {
        _cached = data.url ?? null
        setUrl(_cached)
      })
      .catch(() => {
        _cached = null
        setUrl(null)
      })
  }, [])

  return url
}
