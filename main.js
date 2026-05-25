;(async function () {
    // ===== Config =====
    /** @const {number} - Max comments to select per round. Infinity = all visible. */
    const DELETION_BATCH_SIZE = Infinity
    /** @const {number} - Delay between high-level actions. */
    const DELAY_BETWEEN_ACTIONS_MS = 700
    /** @const {number} - Delay between individual checkbox clicks. */
    const DELAY_BETWEEN_CHECKBOX_CLICKS_MS = 80
    /** @const {number} - Retries when waiting for the Select button to reappear. */
    const MAX_RETRIES = 60
    /** @const {string[]} - Accounts you don't want to delete comments under. */
    const AUTHOR_WHITELIST = []

    // ===== Selectors =====
    const XPATH_SELECT_BUTTON = "//span[text()='Select']/.."
    const XPATH_DELETE_BUTTON = '//span[text()="Delete"]/../../..'
    const XPATH_CONFIRM_DELETE_BUTTON = '//button[div[text()="Delete"]]'
    const XPATH_ERROR_MODAL_OK_BUTTON = '//button[div[text()="OK"]]'

    // ===== Utilities =====
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const waitForElementByXpath = async (xpath, timeout = 30000) => {
        const startTime = Date.now()
        while (Date.now() - startTime < timeout) {
            const element = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null)?.iterateNext()
            if (element) return element
            await delay(100)
        }
        throw new Error(`Element with xpath "${xpath}" not found within ${timeout}ms`)
    }

    const resolveAuthor = (element) => {
        const postContainer = element.closest('[style*="pointer-events: none; flex-direction: column;"]')
        if (!postContainer) throw new Error("Could not resolve post container")
        const author = postContainer.querySelector("span")
        if (!author) throw new Error("Could not resolve author")
        return author.innerText.trim()
    }

    const clickElement = async (element) => {
        if (!element) throw new Error('Element not found')
        element.click()
    }

    const waitForSelectButton = async () => {
        for (let i = 0; i < MAX_RETRIES; i++) {
            const found = document.evaluate(XPATH_SELECT_BUTTON, document, null, XPathResult.ANY_TYPE, null)?.iterateNext()
            if (found) return
            await delay(1000)
        }
        throw new Error('Select button not found after maximum retries')
    }

    const deleteSelectedComments = async () => {
        try {
            const deleteButton = await waitForElementByXpath(XPATH_DELETE_BUTTON)
            await clickElement(deleteButton)
            await delay(DELAY_BETWEEN_ACTIONS_MS)
            const confirmButton = await waitForElementByXpath(XPATH_CONFIRM_DELETE_BUTTON)
            await clickElement(confirmButton)
        } catch (error) {
            console.error('Error during comment deletion:', error.message)
        }
    }

    const deleteActivity = async () => {
        try {
            while (true) {
                const selectButton = Array.from(document.querySelectorAll('span'))
                    .find(span => span.textContent === 'Select')?.parentElement
                if (!selectButton) throw new Error('Select button not found')

                await clickElement(selectButton)
                await delay(DELAY_BETWEEN_ACTIONS_MS)

                const checkboxes = document.querySelectorAll('[aria-label="Toggle checkbox"]')
                if (checkboxes.length === 0) {
                    const errorOk = document.evaluate(XPATH_ERROR_MODAL_OK_BUTTON, document, null, XPathResult.ANY_TYPE, null)?.iterateNext()
                    if (errorOk) {
                        console.log('Instagram rate limit hit, dismissing error modal')
                        await clickElement(errorOk)
                        await delay(DELAY_BETWEEN_ACTIONS_MS)
                        await waitForSelectButton()
                        await delay(DELAY_BETWEEN_ACTIONS_MS)
                        continue
                    } else {
                        console.log('No more comments to delete')
                        break
                    }
                }

                const limit = Math.min(DELETION_BATCH_SIZE, checkboxes.length)
                console.log(`Selecting ${limit} comments...`)
                for (let i = 0; i < limit; i++) {
                    try {
                        if (AUTHOR_WHITELIST.includes(resolveAuthor(checkboxes[i]))) continue
                    } catch (_) { /* author resolution failed, still try to select */ }

                    await clickElement(checkboxes[i])
                    await delay(DELAY_BETWEEN_CHECKBOX_CLICKS_MS)
                }

                await delay(DELAY_BETWEEN_ACTIONS_MS)
                await deleteSelectedComments()
                await delay(DELAY_BETWEEN_ACTIONS_MS)
                await waitForSelectButton()
                await delay(DELAY_BETWEEN_ACTIONS_MS)
            }
        } catch (error) {
            console.error('Error in deleteActivity:', error.message)
        }
    }

    // ===== Main =====
    try {
        await deleteActivity()
        console.log('Activity deletion completed')
    } catch (error) {
        console.error('Fatal error:', error.message)
    }
})()
