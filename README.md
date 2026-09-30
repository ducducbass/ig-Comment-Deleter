;(async function () {
  console.log(
    `[instacl ${new Date().toLocaleTimeString()}] ` +
    'SCRIPT LOADED — STARTING NOW'
  )
  if (window.__instaclRunning) {
    console.warn(
      `[instacl ${new Date().toLocaleTimeString()}] ` +
      'NOT STARTED — another instacl copy is already running in this tab'
    )
    return
  }
  window.__instaclRunning = true
  await new Promise((resolve) => setTimeout(resolve, 0))

  let currentStatus = 'initializing'
  const heartbeatId = setInterval(() => {
    console.log(
      `[instacl ${new Date().toLocaleTimeString()}] ` +
      `HEARTBEAT — still running — ${currentStatus}`
    )
  }, 5000)

  const DELETION_BATCH_SIZE = 5
  const DELAY_BETWEEN_BATCHES_MS = 5000
  const MIN_DELAY_BETWEEN_REQUESTS_MS = 2000
  const MAX_UNCHANGED_PASSES = 5
  const MAX_RATE_LIMIT_RETRIES = 60
  const INITIAL_RATE_LIMIT_BACKOFF_MS = 10000
  const MAX_RATE_LIMIT_BACKOFF_MS = 60000
  const RATE_LIMIT_STORAGE_KEY = 'instacl-rate-limit-state-v2'

  // Fallback from the supplied HAR. Normally the current value is discovered
  // from the comments page's existing WebBloks request.
  const FALLBACK_BLOKS_VERSION =
    'd1000add73c970f1181eb60770ba13d3b56619da7486a5f3e2890bb2f03e490c'

  const SCREEN_APP_ID =
    'com.instagram.privacy.activity_center.comments_screen'
  const DELETE_APP_ID =
    'com.instagram.privacy.activity_center.comments_delete'

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const timestamp = () => new Date().toLocaleTimeString()
  const log = (message) => console.log(`[instacl ${timestamp()}] ${message}`)
  const warn = (message) => console.warn(`[instacl ${timestamp()}] ${message}`)
  const logError = (message) => console.error(`[instacl ${timestamp()}] ${message}`)
  const setStatus = (status) => {
    currentStatus = status
    log(`STATUS — ${status}`)
  }
  const formatDuration = (milliseconds) => {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
  }

  const loadRateLimitState = () => {
    const defaultState = {
      retryCount: 0,
      batchSize: DELETION_BATCH_SIZE,
      actionDelayMs: DELAY_BETWEEN_BATCHES_MS,
      nextRetryAt: 0,
      successStreak: 0
    }

    try {
      const savedState = JSON.parse(
        sessionStorage.getItem(RATE_LIMIT_STORAGE_KEY) || 'null'
      )
      return savedState ? { ...defaultState, ...savedState } : defaultState
    } catch {
      return defaultState
    }
  }

  let rateLimitState = loadRateLimitState()

  const saveRateLimitState = () => {
    try {
      sessionStorage.setItem(
        RATE_LIMIT_STORAGE_KEY,
        JSON.stringify(rateLimitState)
      )
    } catch {
      // Recovery still works for this run if session storage is unavailable.
    }
  }

  const resetRateLimitState = () => {
    rateLimitState = {
      retryCount: 0,
      batchSize: DELETION_BATCH_SIZE,
      actionDelayMs: DELAY_BETWEEN_BATCHES_MS,
      nextRetryAt: 0,
      successStreak: 0
    }
    try {
      sessionStorage.removeItem(RATE_LIMIT_STORAGE_KEY)
    } catch {
      // Nothing else is required.
    }
  }

  const waitForRateLimitCooldown = async () => {
    let remainingMs = rateLimitState.nextRetryAt - Date.now()
    if (remainingMs <= 0) return

    setStatus(
      `rate-limited; retry ${rateLimitState.retryCount}/` +
      `${MAX_RATE_LIMIT_RETRIES} in ${formatDuration(remainingMs)}`
    )
    warn(
      `Rate-limit recovery: waiting ${formatDuration(remainingMs)}. ` +
      `Retry ${rateLimitState.retryCount}/${MAX_RATE_LIMIT_RETRIES}.`
    )

    while (remainingMs > 0) {
      await delay(Math.min(10000, remainingMs))
      remainingMs = rateLimitState.nextRetryAt - Date.now()
      if (remainingMs > 0) {
        log(`Still waiting: ${formatDuration(remainingMs)} remaining.`)
      }
    }

    rateLimitState.nextRetryAt = 0
    saveRateLimitState()
    setStatus('rate-limit wait finished; retrying the same request')
    log('Recovery wait finished. Retrying the same request...')
  }

  const getRetryAfterMs = (response) => {
    const retryAfter = response.headers?.get?.('Retry-After')
    if (!retryAfter) return null

    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

    const retryDate = Date.parse(retryAfter)
    return Number.isNaN(retryDate) ? null : Math.max(0, retryDate - Date.now())
  }

  log(
    `Script loaded. Normal cadence: up to ${DELETION_BATCH_SIZE} comments ` +
    `every ${DELAY_BETWEEN_BATCHES_MS / 1000} seconds.`
  )
  setStatus('initializing request configuration')

  const extractJsonValue = (source, startIndex) => {
    const openingCharacter = source[startIndex]
    const closingCharacter = openingCharacter === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = startIndex; index < source.length; index++) {
      const character = source[index]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (character === '\\') {
          escaped = true
        } else if (character === '"') {
          inString = false
        }
        continue
      }

      if (character === '"') {
        inString = true
      } else if (character === openingCharacter) {
        depth += 1
      } else if (character === closingCharacter) {
        depth -= 1
        if (depth === 0) return JSON.parse(source.slice(startIndex, index + 1))
      }
    }

    throw new Error('Could not read Instagram bootstrap data')
  }

  const readBootstrapModule = (moduleName) => {
    const marker = `["${moduleName}",[],`

    for (const script of document.scripts) {
      const source = script.textContent
      const markerIndex = source.indexOf(marker)
      if (markerIndex === -1) continue

      let valueIndex = markerIndex + marker.length
      while (/\s/.test(source[valueIndex])) valueIndex += 1

      if (source[valueIndex] === '{' || source[valueIndex] === '[') {
        return extractJsonValue(source, valueIndex)
      }
    }

    throw new Error(`Instagram module "${moduleName}" is unavailable`)
  }

  const getPageModule = (moduleName) => {
    try {
      if (typeof window.require === 'function') {
        const moduleValue = window.require(moduleName)
        if (moduleValue != null) return moduleValue
      }
    } catch {
      // Fall back to the module data embedded in the current document.
    }

    return readBootstrapModule(moduleName)
  }

  const getRequestMetadata = () => {
    const dtsgData = getPageModule('DTSGInitialData')
    const lsdData = getPageModule('LSD')
    const siteData = getPageModule('SiteData')
    const fbDtsg = dtsgData.token

    if (!fbDtsg || !lsdData.token) {
      throw new Error('Could not obtain current Instagram request tokens')
    }

    return {
      fbDtsg,
      jazoest: `2${[...fbDtsg].reduce(
        (total, character) => total + character.charCodeAt(0),
        0
      )}`,
      lsd: lsdData.token,
      siteData
    }
  }

  const findBloksVersion = () => {
    const resourceUrl = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) =>
        url.includes('/async/wbloks/fetch/') &&
        url.includes('com.instagram.privacy.activity_center.comments_')
      )

    if (!resourceUrl) return FALLBACK_BLOKS_VERSION
    return new URL(resourceUrl).searchParams.get('__bkv') ||
      FALLBACK_BLOKS_VERSION
  }

  let requestMetadata
  let bloksVersion

  try {
    setStatus('reading authentication metadata from the logged-in page')
    requestMetadata = getRequestMetadata()
    bloksVersion = findBloksVersion()
    setStatus('authentication loaded; preparing direct requests')
  } catch (error) {
    logError(`Startup failed: ${error.message}`)
    clearInterval(heartbeatId)
    window.__instaclRunning = false
    log('SCRIPT ENDED')
    return
  }

  let requestSequence = Date.now() % 1296
  let networkRequestCount = 0
  let lastRequestFinishedAt = 0

  const waitForRequestSpacing = async () => {
    const elapsedMs = Date.now() - lastRequestFinishedAt
    const remainingMs = MIN_DELAY_BETWEEN_REQUESTS_MS - elapsedMs
    if (lastRequestFinishedAt === 0 || remainingMs <= 0) return

    setStatus(
      `waiting ${formatDuration(remainingMs)} before the next network request`
    )
    log(
      `Request spacing: waiting ${remainingMs} ms so requests are at least ` +
      `${MIN_DELAY_BETWEEN_REQUESTS_MS} ms apart.`
    )
    await delay(remainingMs)
  }

  const getInstagramAsyncParams = () => {
    try {
      const getAsyncParams = window.require('getAsyncParams')
      if (typeof getAsyncParams === 'function') {
        return getAsyncParams('POST')
      }
    } catch {
      // The required live values are supplied below.
    }

    return {}
  }

  const makeRequestBody = (params) => {
    const { fbDtsg, jazoest, lsd, siteData } = requestMetadata
    const values = {
      ...getInstagramAsyncParams(),
      __d: 'www',
      __user: '0',
      __a: '1',
      __req: (requestSequence++).toString(36),
      __hs: siteData.haste_session,
      dpr: siteData.pr ?? window.devicePixelRatio ?? 1,
      __ccg: 'EXCELLENT',
      __rev: siteData.client_revision ?? siteData.__spin_r,
      __hsi: siteData.hsi,
      __comet_req: siteData.comet_env ?? 7,
      fb_dtsg: fbDtsg,
      jazoest,
      lsd,
      __spin_r: siteData.__spin_r,
      __spin_b: siteData.__spin_b,
      __spin_t: siteData.__spin_t,
      __crn: 'comet.igweb.PolarisYourActivityInteractionsRoute',
      params: JSON.stringify(params)
    }

    const body = new URLSearchParams()
    for (const [name, value] of Object.entries(values)) {
      if (
        value != null &&
        ['string', 'number', 'boolean'].includes(typeof value)
      ) {
        body.set(name, String(value))
      }
    }
    return body
  }

  const makeWbloksUrl = (appId, type) => {
    const url = new URL('/async/wbloks/fetch/', window.location.origin)
    url.searchParams.set('appid', appId)
    url.searchParams.set('type', type)
    url.searchParams.set('__bkv', bloksVersion)
    return url
  }

  const postWbloks = async (appId, type, params, description) => {
    await waitForRequestSpacing()

    const requestNumber = ++networkRequestCount
    const startTime = performance.now()
    setStatus(description)
    log(`Request ${requestNumber}: ${description}`)

    const response = await fetch(makeWbloksUrl(appId, type), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: makeRequestBody(params)
    })

    const elapsedMs = Math.round(performance.now() - startTime)
    currentStatus = `processing HTTP ${response.status} response`
    log(`Request ${requestNumber}: HTTP ${response.status} after ${elapsedMs} ms`)

    const responseText = await response.text()
    lastRequestFinishedAt = Date.now()
    if (response.status === 429) {
      const error = new Error('Instagram returned HTTP 429')
      error.status = 429
      error.retryAfterMs = getRetryAfterMs(response)
      throw error
    }
    if (!response.ok) {
      throw new Error(`Instagram request failed with HTTP ${response.status}`)
    }
    if (!responseText) {
      throw new Error('Instagram returned an empty response')
    }

    const jsonText = responseText.replace(/^for \(;;\);/, '')
    const result = JSON.parse(jsonText)
    if (result.error || result.errorSummary) {
      throw new Error(result.errorSummary || result.errorDescription || result.error)
    }
    return result
  }

  const randomBetween = (minimum, maximum) =>
    Math.round(minimum + Math.random() * (maximum - minimum))

  const recoverFromRateLimit = async (error) => {
    rateLimitState.retryCount += 1
    if (rateLimitState.retryCount > MAX_RATE_LIMIT_RETRIES) {
      throw new Error(
        `Instagram still returned HTTP 429 after ${MAX_RATE_LIMIT_RETRIES} retries.`
      )
    }

    const previousBatchSize = rateLimitState.batchSize
    const previousDelayMs = rateLimitState.actionDelayMs
    rateLimitState.batchSize = Math.max(
      1,
      Math.ceil(rateLimitState.batchSize / 2)
    )
    rateLimitState.actionDelayMs = Math.min(
      MAX_RATE_LIMIT_BACKOFF_MS,
      Math.max(
        INITIAL_RATE_LIMIT_BACKOFF_MS,
        Math.round(rateLimitState.actionDelayMs * 1.5)
      )
    )
    rateLimitState.successStreak = 0

    const waitCeilingMs = Math.max(
      1000,
      Math.min(
        error.retryAfterMs ?? rateLimitState.actionDelayMs,
        MAX_RATE_LIMIT_BACKOFF_MS
      )
    )
    const waitFloorMs = Math.max(1000, Math.round(waitCeilingMs / 2))
    const jitteredWaitMs = randomBetween(waitFloorMs, waitCeilingMs)
    rateLimitState.nextRetryAt = Date.now() + jitteredWaitMs
    saveRateLimitState()

    warn(
      `HTTP 429 recovery ${rateLimitState.retryCount}/${MAX_RATE_LIMIT_RETRIES}: ` +
      `batch ${previousBatchSize} → ${rateLimitState.batchSize}, ` +
      `cadence ${formatDuration(previousDelayMs)} → ` +
      `${formatDuration(rateLimitState.actionDelayMs)}.`
    )
    warn(
      `Jitter selected ${formatDuration(jitteredWaitMs)} from a ` +
      `${formatDuration(waitFloorMs)}–${formatDuration(waitCeilingMs)} window.`
    )
    await waitForRateLimitCooldown()
  }

  const recordSuccessfulBatch = () => {
    const recoveredRetryCount = rateLimitState.retryCount
    rateLimitState.retryCount = 0
    rateLimitState.nextRetryAt = 0
    rateLimitState.successStreak += 1

    if (recoveredRetryCount > 0) {
      log(
        `✅ Rate-limit recovery succeeded after ${recoveredRetryCount} ` +
        `retry attempt(s).`
      )
    }

    if (rateLimitState.successStreak >= 2) {
      const previousBatchSize = rateLimitState.batchSize
      const previousDelayMs = rateLimitState.actionDelayMs
      rateLimitState.batchSize = Math.min(
        DELETION_BATCH_SIZE,
        rateLimitState.batchSize + 2
      )
      rateLimitState.actionDelayMs = Math.max(
        DELAY_BETWEEN_BATCHES_MS,
        Math.round(rateLimitState.actionDelayMs * 0.85)
      )
      rateLimitState.successStreak = 0

      if (
        previousBatchSize !== rateLimitState.batchSize ||
        previousDelayMs !== rateLimitState.actionDelayMs
      ) {
        log(
          `Adaptive recovery scale-up: batch ${previousBatchSize} → ` +
          `${rateLimitState.batchSize}, cadence ` +
          `${formatDuration(previousDelayMs)} → ` +
          `${formatDuration(rateLimitState.actionDelayMs)}.`
        )
      }
    }

    if (
      rateLimitState.batchSize === DELETION_BATCH_SIZE &&
      rateLimitState.actionDelayMs === DELAY_BETWEEN_BATCHES_MS
    ) {
      resetRateLimitState()
    } else {
      saveRateLimitState()
    }
  }

  const collectStrings = (value, strings) => {
    if (typeof value === 'string') {
      strings.push(value)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const childValue of Object.values(value)) {
      collectStrings(childValue, strings)
    }
  }

  const readPositiveInteger = (value) => {
    const number = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : NaN

    return Number.isSafeInteger(number) && number > 0 ? number : undefined
  }

  const findContentIdsInObjects = (value) => {
    if (!value || typeof value !== 'object') return null

    if (!Array.isArray(value)) {
      const contentContainerId = readPositiveInteger(value.content_container_id)
      const contentElementId = readPositiveInteger(value.content_element_id)
      if (contentContainerId && contentElementId) {
        return { contentContainerId, contentElementId }
      }
    }

    for (const childValue of Object.values(value)) {
      const contentIds = findContentIdsInObjects(childValue)
      if (contentIds) return contentIds
    }

    return null
  }

  const findContentIdsInStrings = (strings) => {
    const containerIdPattern =
      /\\*"content_container_id\\*"\s*:\s*\\*"?(\d+)/
    const elementIdPattern =
      /\\*"content_element_id\\*"\s*:\s*\\*"?(\d+)/

    // A page with more results includes these values in serialized pagination
    // parameters. The final page may omit pagination, so do not rely on this
    // representation being present.
    for (const value of strings) {
      const containerMatch = value.match(containerIdPattern)
      const elementMatch = value.match(elementIdPattern)
      if (!containerMatch || !elementMatch) continue

      return {
        contentContainerId: Number(containerMatch[1]),
        contentElementId: Number(elementMatch[1])
      }
    }

    // The delete action itself always needs the two IDs. In its WebBloks
    // manifest, the values array has the same order as the preceding keys
    // array. This form remains available when there is no "next page" action.
    const deleteManifestPattern =
      /AsyncActionWithDataManifest,\s*"com\.instagram\.privacy\.activity_center\.comments_delete"[\s\S]*?\(bk\.action\.map\.Make,\s*\(bk\.action\.array\.Make,\s*"content_container_id",\s*"content_element_id",\s*"content_spinner_id"(?:,\s*"[^"]+")*\),\s*\(bk\.action\.array\.Make,\s*\(bk\.action\.i(?:32|64)\.Const,\s*(\d+)\),\s*\(bk\.action\.i(?:32|64)\.Const,\s*(\d+)\)/

    for (const value of strings) {
      const match = value.match(deleteManifestPattern)
      if (!match) continue

      return {
        contentContainerId: Number(match[1]),
        contentElementId: Number(match[2])
      }
    }

    return null
  }

  const parseCommentsScreen = (screenResponse) => {
    const strings = []
    collectStrings(screenResponse, strings)

    const pairs = new Set()
    const commentPattern =
      /"comment_id"[\s\S]*?\), \(bk\.action\.array\.Make, "(\d+)"[\s\S]*?, "(\d+)", \(bk\.action\.bool\.Const, (true|false)\)/g

    for (const value of strings) {
      commentPattern.lastIndex = 0
      for (const match of value.matchAll(commentPattern)) {
        const [, commentId, postId, shouldIncludeCheckbox] = match
        if (shouldIncludeCheckbox === 'true') {
          pairs.add(`${postId}:${commentId}`)
        }
      }
    }

    const contentIds =
      findContentIdsInObjects(screenResponse) ||
      findContentIdsInStrings(strings) ||
      {}
    const { contentContainerId, contentElementId } = contentIds

    if (pairs.size > 0 && (!contentContainerId || !contentElementId)) {
      throw new Error(
        `Could not read the current WebBloks content identifiers for ` +
        `${pairs.size} comment(s)`
      )
    }

    return {
      pairs: [...pairs],
      contentContainerId,
      contentElementId
    }
  }

  const getCurrentComments = async () => {
    const response = await postWbloks(
      SCREEN_APP_ID,
      'app',
      {},
      'loading the current comments page'
    )
    return parseCommentsScreen(response)
  }

  const deleteComments = async (
    pairs,
    contentContainerId,
    contentElementId
  ) => {
    await postWbloks(DELETE_APP_ID, 'action', {
      content_container_id: contentContainerId,
      content_element_id: contentElementId,
      content_spinner_id: contentElementId + 1,
      main_order_state_value: true,
      main_attribute_order_state_value: 'newest_to_oldest',
      main_date_start_state_value: -1,
      main_date_end_state_value: -1,
      main_authors_state_value: '',
      main_filter_to_visible_on_facebook_value: false,
      main_includes_location_value: false,
      main_liked_privately_value: false,
      main_content_type_value: 0,
      main_content_types_value: 'Posts, Reels',
      main_account_history_events_state_value: '',
      entrypoint: '',
      shared_user_id: '',
      main_filter_to_visible_from_facebook_value: false,
      items_for_action: pairs.join(','),
      number_of_items: pairs.length
    }, `deleting a batch of ${pairs.length} comment(s)`)
  }

  try {
    const deletedPairs = new Set()
    let deletedCount = 0
    let unchangedPasses = 0
    let pageCount = 0
    let batchCount = 0
    let deleteAttemptCount = 0

    log('Automation loop started. Fetching comments without using the UI.')
    if (rateLimitState.nextRetryAt > Date.now()) {
      warn(
        `A saved rate-limit cooldown is active for another ` +
        `${formatDuration(rateLimitState.nextRetryAt - Date.now())}.`
      )
    }

    while (true) {
      pageCount += 1
      log(`Loading comment page ${pageCount}...`)

      const {
        pairs,
        contentContainerId,
        contentElementId
      } = await getCurrentComments()
      const pendingPairs = pairs.filter((pair) => !deletedPairs.has(pair))

      if (pairs.length === 0) {
        log(
          `✅ Finished. Deleted ${deletedCount} comment(s) in ` +
          `${batchCount} batch(es) using ${networkRequestCount} request(s).`
        )
        return
      }

      if (pendingPairs.length === 0) {
        unchangedPasses += 1
        warn(
          `Instagram returned ${pairs.length} previously processed comment(s). ` +
          `Refresh check ${unchangedPasses}/${MAX_UNCHANGED_PASSES}.`
        )
        if (unchangedPasses >= MAX_UNCHANGED_PASSES) {
          warn(
            `Stopped after deleting ${deletedCount} comment(s) because ` +
            'Instagram kept returning the same page.'
          )
          return
        }
        log('Waiting 3 seconds before checking the comments page again...')
        await delay(3000)
        continue
      }

      unchangedPasses = 0
      log(
        `Page ${pageCount}: found ${pairs.length} deletable comment(s); ` +
        `${pendingPairs.length} remain unprocessed.`
      )

      const remainingPairs = [...pendingPairs]
      while (remainingPairs.length > 0) {
        await waitForRateLimitCooldown()

        const batchSize = Math.max(
          1,
          Math.min(rateLimitState.batchSize, remainingPairs.length)
        )
        const batch = remainingPairs.slice(0, batchSize)
        deleteAttemptCount += 1
        log(
          `Delete attempt ${deleteAttemptCount}: sending ${batch.length} ` +
          `comment(s) with ${remainingPairs.length} remaining on this page. ` +
          `Total deleted before batch: ${deletedCount}.`
        )

        try {
          await deleteComments(batch, contentContainerId, contentElementId)
        } catch (error) {
          if (error.status !== 429) throw error
          await recoverFromRateLimit(error)
          continue
        }

        remainingPairs.splice(0, batch.length)
        for (const pair of batch) deletedPairs.add(pair)
        batchCount += 1
        deletedCount += batch.length
        recordSuccessfulBatch()

        log(
          `✅ Batch ${batchCount} succeeded. Deleted ${batch.length} comment(s). ` +
          `Total deleted: ${deletedCount}.`
        )
        const actionDelayMs = rateLimitState.actionDelayMs
        setStatus(
          `waiting ${formatDuration(actionDelayMs)} after successful batch ` +
          `${batchCount}`
        )
        log(
          `Waiting ${formatDuration(actionDelayMs)} before continuing. ` +
          `Next action at ${new Date(Date.now() + actionDelayMs).toLocaleTimeString()}.`
        )
        await delay(actionDelayMs)
        log('Batch wait finished. Continuing...')
      }
    }
  } catch (error) {
    logError(`Stopped after an error: ${error.message}`)
  } finally {
    currentStatus = 'stopped'
    clearInterval(heartbeatId)
    window.__instaclRunning = false
    log('SCRIPT ENDED')
  }
})()
