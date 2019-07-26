
const { Client: ESClient } = require('elasticsearch')

const ELASTIC_SEARCH_HOST = process.env.ELASTIC_SEARCH_HOST || 'http://localhost:9200'

module.exports = connectionClass => {

  const elasticSearchConfig = {
    ...(connectionClass ? { connectionClass } : {}),
    hosts: [ELASTIC_SEARCH_HOST],
  }

  return new ESClient(elasticSearchConfig)
}
