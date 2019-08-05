const path = require('path')

const AdmZip = require('adm-zip')
const axios = require('axios')
const qs = require('querystring')
const yaml = require('js-yaml')

const { parser } = require('./parser')

const FILE_EXTENSION = '.md'
const INDEX_TYPE = '_doc'

class ESUpdateJob {
  constructor(esClient) {
    this.esClient = esClient
    this.documentTitles = {}
  }

  createEsSearchIndex(esIndex) {
    let options = {
      existingIndex: { index: esIndex },
      createIndex: {
        index: esIndex,
        body: {
          mappings: {},
        },
      },
    }
    options.createIndex.body.mappings[INDEX_TYPE] = {
      'properties': {
        'title': { 'type': 'text' },
        'url': { 'type': 'text' },
        'content': { 'type': 'text' },
        'documentTitle': { 'type': 'text' },
        'documentId': { 'type': 'keyword' },
      },
    }

    return this.esClient.indices.exists(options.existingIndex)
      .then((exist) => {
        if (exist) {
          console.info(`Index (${esIndex}) exists, deleting index`)
          return this.esClient.indices.delete(options.existingIndex)
        } else {
          return Promise.resolve()
        }
      })
      .then(() => {
        console.info(`Creating index: ${esIndex}`)
        return this.esClient.indices.create(options.createIndex)
      })
      .catch((err) => {
        console.error(err)
        throw (err)
      })
  }

  makeEntryId(url, ext = FILE_EXTENSION) {
    const blist = /[^A-Za-z0-9/\-()_+&]/g
    let entryId = qs.unescape(url).replace(blist, '')
    if (entryId === '/') {
      entryId = 'root'
    }
    return entryId
  }

  urlEncodePath(filename, ext = FILE_EXTENSION) {
    const fileExtensionRegex = new RegExp(ext + '$')
    return encodeURI(filename.replace(fileExtensionRegex, '.html'))
  }

  // This should have pretty much the implementation as the one on client side (document-info.txt)
  getDocumentTitle(filename, repoRootPath, file, repo) {
    const filePathParts = filename.split('/')
    // if in subdirectory
    if (filePathParts.length > 1) {
      const subFolder = filePathParts[0]
      // If already cached, return document title
      if (this.documentTitles[subFolder]) {
        return this.documentTitles[subFolder]
      }
      // If config file exists, check if title is set
      const configFilePath = path.join(repoRootPath, subFolder, 'index.md')
      const configFile = repo.getEntry(configFilePath)
      if (configFile) {
        try {
          const configString = configFile.getData()
            .toString('utf8')
            .replace(/---/g, '')
          const config = yaml.safeLoad(configString)
          if (config.title) {
            this.documentTitles[subFolder] = config.title.toString()
          }
        } catch (e) {
          console.error(e)
        }
      }
      // Or else use document folder name as title
      if (!this.documentTitles[subFolder]) {
        // to title case
        this.documentTitles[subFolder] = subFolder.replace(/\w\S*/g, (txt) => {
          return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
        })
      }
      return this.documentTitles[subFolder]
    }
    return null
  }

  // This should have the same implementation as the one on client side (search.js)
  getDocumentId(documentTitle) {
    if (!documentTitle) {
      return null
    }
    return documentTitle.replace(/[^\w]/g, '').toLowerCase()
  }

  async getRepo(repoName, branch) {
    const codeloadURL = `https://codeload.github.com/opendocsg/${repoName}/zip/${branch}`
    const { data: codeload } = await axios(codeloadURL, { responseType: 'arraybuffer' })
    return new AdmZip(codeload)
  }

  async sendToES (dataToSend) {
    const sendingPromises = []

    if (dataToSend.length > 0) {
      // Work around the Payload-too-large error by sending multiple smaller requests
      let len = 0
      let curr = 0
      var start = 0
      var end = 1
      for (let i = 0; i < dataToSend.length; i++) {
        curr = JSON.stringify(dataToSend[i][1]).length
        len = len + curr
        if (len * 2 > 10485760 || (i === (dataToSend.length - 1))) {
          end = (i === (dataToSend.length - 1)) ? i + 1 : i

          var sliced = [].concat.apply([], dataToSend.slice(start, end))
          sendingPromises.push(this.esClient.bulk({ body: sliced }))
          len = curr
          start = i
        }
      }
    }

    return Promise.all(sendingPromises)
  }

  async run(params) {
    const { index: esIndex, repoName, branch = 'master' } = params
    const repo = await this.getRepo(repoName, branch)
    const markdownFiles = repo.getEntries().filter(entry => {
      return entry.name.endsWith(FILE_EXTENSION) &&
        !entry.isDirectory &&
        !entry.entryName.match(/^(_|\.|assets).*/)
    })
    // For root folder:
    // If index.md is not present, github pages will use readme.md as index page
    // So if index.md exists, remove readme.md
    const filesToIndex = markdownFiles.some(x => x.name.toLowerCase() === 'index.md')
      ? markdownFiles.filter(x => x.name.toLowerCase() !== 'readme.md')
      : markdownFiles

    await this.createEsSearchIndex(esIndex)

    const repoRootPath = `${repoName}-${branch}/`

    // Form the request to upsert all files ending in '.md', that are in the repo
    for (const file of filesToIndex) {
      const content = file.getData().toString('utf8')
      const filename = file.entryName.replace(repoRootPath, '')

      const entryId = this.makeEntryId(filename)
      const documentTitle = this.getDocumentTitle(filename, repoRootPath, file, repo)
      const documentId = this.getDocumentId(documentTitle)
      const url = this.urlEncodePath(filename)
      const sections = await parser({ url, content })
      const sectionIndices = sections.map((section, i) => {
        const sectionId = { index: { _index: esIndex, _type: INDEX_TYPE, _id: `${entryId}_${i}` } }
        const sectionData = { doc_as_upsert: true, title: section.title, url: section.url, content: section.text, documentTitle, documentId }
        return [sectionId, sectionData]
      })
      await this.sendToES(sectionIndices)
    }

    console.info(`Successfully created/updated index: ${esIndex}`)

    return Promise.resolve()
  }
}

module.exports = ESUpdateJob
