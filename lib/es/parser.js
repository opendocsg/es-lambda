const util = require('util')
const jsdom = require('jsdom')
const DOM_API = new jsdom.JSDOM().window
const kramed = util.promisify(require('kramed'))
const HEADER_TAGS = ['H1', 'H2', 'H3']

// Override kramed lex function to prevent replacement of non-breaking space with spaces
// In accordance to kramdown's way of parsing
// Original file: https://github.com/GitbookIO/kramed/blob/master/lib/lex/block.js line 54 removed
// Warning: Do not use arrow syntax for this override, `this` should refer to object instance
kramed.Lexer.prototype.lex = function(src) {
  src = src
    .replace(/\r\n|\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/\u2424/g, '\n')

  return this.token(src, true)
}

function getHeadersAndText(root) {
  let walker = DOM_API.document.createTreeWalker(root, DOM_API.NodeFilter.SHOW_ALL, {
    acceptNode: (node) => {
      if (HEADER_TAGS.indexOf(node.tagName) >= 0) {
        return DOM_API.NodeFilter.FILTER_ACCEPT
      }
      if (HEADER_TAGS.indexOf(node.parentNode.tagName) >= 0) {
        return DOM_API.NodeFilter.FILTER_REJECT
      }
      if (node.nodeType === 3) {
        return DOM_API.NodeFilter.FILTER_ACCEPT
      }
      return DOM_API.NodeFilter.FILTER_SKIP
    },
  }, false)
  let nodes = []
  let node = walker.nextNode()
  while (node) {
    nodes.push(node)
    node = walker.nextNode()
  }
  return nodes
}

function parser(options) {
  const allSections = []
  return kramed(options.content).then((content) => {
    const existingIds = {}
    const body = new jsdom.JSDOM(content).window.document.body
    const headersAndText = getHeadersAndText(body)
    let currentSection = null
    headersAndText.forEach((node) => {
      if (currentSection) {
        if (HEADER_TAGS.indexOf(node.tagName) < 0) {
          currentSection.text.push(node.textContent)
        } else {
          allSections.push(currentSection)
        }
      }
      if (HEADER_TAGS.indexOf(node.tagName) >= 0) {
        const urlParts = options.url.split('/')
        let filename = urlParts.pop()
        if (['index.html', 'readme.html'].includes(filename.toLowerCase())) {
          filename = ''
        }
        const pageUrl = urlParts.concat(filename).join('/')

        let sectionId = generateIdFromTitle(node.textContent)
        if (existingIds[sectionId] != null) {
          // if id exists, add -1, -2 and so forth..
          sectionId += '-' + (existingIds[sectionId] += 1)
        } else {
          existingIds[sectionId] = 0
        }

        currentSection = {
          title: node.textContent,
          url: pageUrl + '#' + sectionId,
          text: [],
        }
      }
    })
    if (currentSection) {
      allSections.push(currentSection)
    }
    allSections.forEach((child) => {
      child.text = child.text
        .join('')
        .replace(/\{[:#][^{}\r\n]+\}/g, '') // Removes inline attribute list (IAL), see: https://kramdown.gettalong.org/syntax.html#inline-attribute-lists
        .trim()
    })
    return allSections
  }).catch((err) => {
    console.error(err)
  })
}

function generateIdFromTitle(title) {
  // Remove characters that are not alphanumeric, dashes or spaces
  let generatedId = title.trimLeft().replace(/[ ]/g, '-')
  generatedId = generatedId.toLowerCase().replace(/[^a-z0-9- ]+/g, '')
  return generatedId
}

module.exports = {
  parser,
  generateIdFromTitle,
  getHeadersAndText,
  kramed,
}
