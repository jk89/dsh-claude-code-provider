// Drive the dsh web UI of the isolated test profile with Playwright (test helper, not shipped).
// Usage: node drive.mjs <url-with-token> <script.json> <out-dir>
// script.json: [{ "do": "model", "name": "Claude Code - Haiku 5.5" }, { "do": "send", "text": "..." },
//               { "do": "wait", "text": "...", "ms": 120000 }, { "do": "click", "text": "Allow" },
//               { "do": "shot", "name": "x" }, { "do": "sleep", "ms": 1000 }, { "do": "dump" }]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(`${readFileSync('/tmp/pw-path', 'utf8').trim()}/playwright`)
const [url, scriptPath, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const steps = JSON.parse(readFileSync(scriptPath, 'utf8'))

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await page.goto(url)
await page.waitForSelector('[data-composer-input=true]', { timeout: 30000 })
const cont = page.getByRole('button', { name: 'Continue' })
if (await cont.count()) await cont.first().click().catch(() => {})

for (const step of steps) {
  const t0 = Date.now()
  try {
    switch (step.do) {
      case 'goto': await page.goto(step.url); await page.waitForTimeout(1500); break
      case 'model': {
        await page.locator('button[aria-label^="Select model"]').click()
        await page.getByRole('menuitem', { name: /^Model/ }).click()
        await page.getByRole('menu').last().getByText(step.name, { exact: true }).first().click()
        if (step.effort) {
          await page.locator('button[aria-label^="Select model"]').click()
          await page.getByRole('menuitem', { name: /^Effort/ }).click()
          await page.getByRole('menu').last().getByText(step.effort, { exact: true }).first().click()
        }
        console.log('model:', await page.locator('button[aria-label^="Select model"]').getAttribute('aria-label'))
        break
      }
      case 'send': {
        const input = page.locator('[data-composer-input=true]')
        await input.click()
        await page.keyboard.type(step.text)
        await page.keyboard.press(step.key ?? 'Enter')
        break
      }
      case 'wait': await page.getByText(step.text).first().waitFor({ timeout: step.ms ?? 120000 }); break
      case 'click': await page.getByRole('button', { name: step.text, exact: step.exact ?? false }).first().click({ timeout: step.ms ?? 60000 }); break
      case 'clickSel': await page.locator(step.sel).first().click({ timeout: step.ms ?? 30000 }); break
      case 'attrs': console.log('attrs:', JSON.stringify(await page.locator(step.sel).evaluateAll(els => els.map(e => e.getAttribute('aria-label') ?? e.getAttribute('title') ?? e.innerText)))); break
      case 'clickText': await page.getByText(step.text, { exact: step.exact ?? false }).first().click({ timeout: step.ms ?? 60000 }); break
      case 'sleep': await page.waitForTimeout(step.ms); break
      case 'shot': await page.screenshot({ path: `${outDir}/${step.name}.png`, fullPage: false }); break
      case 'dump': {
        const text = await page.locator('main').first().innerText().catch(() => page.locator('body').innerText())
        writeFileSync(`${outDir}/${step.name ?? 'dump'}.txt`, text)
        console.log(`--- dump ${step.name ?? ''}\n${text.slice(-(step.tail ?? 3000))}`)
        break
      }
      case 'expandAll': {
        for (let round = 0; round < 4; round++) {
          const n = await page.evaluate(() => {
            const els = [...document.querySelectorAll('[aria-expanded="false"]:not(nav *):not(aside *)')]
            els.forEach(el => el.click())
            return els.length
          })
          await page.waitForTimeout(500)
          if (n === 0) break
        }
        break
      }
      case 'expandText': {
        await page.evaluate((text) => {
          const el = [...document.querySelectorAll('[aria-expanded="false"]')].find(e => (e.innerText || '').includes(text))
          el?.click()
        }, step.text)
        await page.waitForTimeout(500)
        break
      }
      case 'eval': console.log('eval:', String(JSON.stringify(await page.evaluate(step.js))).slice(0, 4000)); break
      case 'buttons': console.log('buttons:', (await page.getByRole('button').allInnerTexts()).filter(Boolean).join(' | ')); break
      default: throw new Error(`unknown step ${step.do}`)
    }
    console.log(`ok ${step.do} ${step.text ?? step.name ?? ''} (${Date.now() - t0}ms)`)
  } catch (error) {
    console.log(`FAIL ${step.do} ${step.text ?? step.name ?? ''}: ${error.message.split('\n')[0]}`)
    await page.screenshot({ path: `${outDir}/fail-${steps.indexOf(step)}.png` })
    if (!step.optional) break
  }
}
console.log('url:', page.url())
await browser.close()
