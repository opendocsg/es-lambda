const fs = require('fs')
const path = require('path')
const util = require('util')

const glob = require('glob')
const qs = require('querystring')
const rimraf = require('rimraf')
const shell = require('shelljs')
const yaml = require('js-yaml')

const readFilePromise = util.promisify(fs.readFile)
const globPromise = util.promisify(glob)

const { parser } = require('./parser')

const FILE_EXTENSION = '.md'
const INDEX_TYPE = '_doc'

class ESUpdateJob {
  constructor(esClient) {
    this.esClient = esClient
    this.documentTitles = {}
  }

  readFileContent(filename) {
    return readFilePromise(filename, 'utf8')
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

  getFilenames(directory, ext = FILE_EXTENSION) {
    const globDir = path.join(directory, '**', '*' + ext)
    const blacklistedPaths = /^(_|\.|assets).*/
    const fileDirectoryPrefixRegex = new RegExp('^' + directory + '/')
    return globPromise(globDir).then((files) => {
      let filesToIndex = files
        .map(filePath => {
          // Remove directory path in front and the trailing slash
          return filePath.replace(fileDirectoryPrefixRegex, '')
        })
        .filter(filePath => {
          // Remove blacklisted paths
          return !filePath.match(blacklistedPaths)
        })
      return filesToIndex
    })
  }

  // This should have pretty much the implementation as the one on client side (document-info.txt)
  getDocumentTitle(directory, filename) {
    const filePathParts = filename.split('/')
    // if in subdirectory
    if (filePathParts.length > 1) {
      const subFolder = filePathParts[0]
      // If already cached, return document title
      if (this.documentTitles[subFolder]) {
        return this.documentTitles[subFolder]
      }
      // If config file exists, check if title is set
      const configFilePath = path.join(directory, subFolder, 'index.md')
      if (fs.existsSync(configFilePath)) {
        try {
          const configString = fs.readFileSync(configFilePath).toString().replace(/---/g, '')
          const config = yaml.safeLoad(configString)
          if (config.title) {
            this.documentTitles[subFolder] = config.title
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

  gitClone(url, directory, branch) {
    return this.deleteDirectory(directory)
      .then(() => {
        shell.mkdir('-p', directory)
        this.git = Git(directory)
        return this.git.clone(url, directory, ['--branch', branch || 'master'])
      })
      .then(() => {
        console.info('Git cloned')
      }).catch((err) => {
        throw err
      })
  }

  deleteDirectory(directory) {
    return new Promise((resolve, reject) => {
      rimraf(directory, { glob: false }, (err) => {
        if (err) {
          reject(err)
        } else {
          console.info('Directory deleted')
          resolve()
        }
      })
    })
  }

  run(params) {
    const { index: esIndex, directory: gitDirectory, url, branch } = params
    return this.gitClone(url, gitDirectory, branch).then(() => {
      let filenamesToIndex = []
      return this.getFilenames(gitDirectory)
        .then((files) => {
          // For root folder:
          // If index.md is not present, github pages will use readme.md as index page
          // So if index.md exists, remove readme.md
          filenamesToIndex = files
          if (files.some(x => x.toLowerCase() === 'index.md')) {
            filenamesToIndex = files.filter(filename => filename.toLowerCase() !== 'readme.md')
          }
          return this.createEsSearchIndex(esIndex)
        })
        .then(() => {
          // Form the request to upsert all files ending in '.md', that are in the repo
          const indexPromises = filenamesToIndex.map((filename) => {
            return this.readFileContent(path.join(gitDirectory, filename)).then((contents) => {
              const entryId = this.makeEntryId(filename)
              const documentTitle = this.getDocumentTitle(gitDirectory, filename)
              const documentId = this.getDocumentId(documentTitle)
              const url = this.urlEncodePath(filename)
              return parser({ url: url, content: contents }).then((sections) => {
                const sectionIndices = sections.map((section, i) => {
                  const sectionId = { index: { _index: esIndex, _type: INDEX_TYPE, _id: `${entryId}_${i}` } }
                  const sectionData = { doc_as_upsert: true, title: section.title, url: section.url, content: section.text, documentTitle, documentId }
                  return [sectionId, sectionData]
                })
                return sectionIndices
              }).catch(e => {
                console.error(e)
                throw e
              })
            })
          })

          return Promise.all(indexPromises).then((dataToSend) => {
            var sendingPromises = []

            if (dataToSend.length > 0) {
              dataToSend = [].concat.apply([], dataToSend)
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

            return Promise.all(sendingPromises).then(
              () => {
                console.info(`Successfully created/updated index: ${esIndex}`)
              })
              .catch((err) => {
                let e = { description: 'Upload data to ES failed ' }
                if (err) { Object.assign(e, err) }
                console.error(e)
              })
          }).catch((err) => {
            let e = { description: 'Something went wrong while forming the upsert details' }
            if (err) { Object.assign(e, err) }
            console.error(e)
            throw err
          })
        })
    }).then(() => {
      this.deleteDirectory(gitDirectory)
    }).catch((err) => {
      console.error(JSON.stringify(err))
      throw err
    })
  }
}

module.exports = ESUpdateJob
