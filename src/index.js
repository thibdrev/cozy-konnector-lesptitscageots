const {
  BaseKonnector,
  requestFactory,
  scrape,
  log,
  utils,
} = require('cozy-konnector-libs')

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses.
  // Very useful for debugging but very verbose. This is why it is commented out by default
  // debug: true,

  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,

  // If cheerio is activated, do not forget to deactivate json parsing
  // (which is activated by default in cozy-konnector-libs)
  json: false,

  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'Les ptits cageots'
const baseUrl = 'https://www.lesptitscageots.fr'

module.exports = new BaseKonnector(start)


/**
 * The start function is run by the BaseKonnector instance only when it got all
 * the account information (fields).
 * @param {object} fields: When you run this connector yourself in "standalone" mode
 * or "dev" mode, the account information come from ./konnector-dev-config.json file.
 * @param {object} cozyParameters: static parameters, independents from the account.
 * Most often, it can be a secret api key.
*/
async function start(fields, cozyParameters) {

  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  const $ = await request(`${baseUrl}/historique-des-commandes`)

  // Parsing the invoices
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  log('info', 'Saving data to Cozy')
  await this.saveBills(documents, fields, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['Les P Tits Cag'],
    // sourceAccount given to saveBills and saveFiles
    sourceAccount: fields.login,
    // deduplication keys used for file deduplication
    keys: ['vendorRef', 'date', 'amount']
  })

}


// authentification using the website form
function authenticate(username, password) {

  return this.signin({

    // <form action="https://www.lesptitscageots.fr/authentification" method="post" id="login_form" class="box">
    url: `${baseUrl}/authentification`,
    formSelector: 'form#login_form',

    // <input ... type="text" name="email" />
    // <input ... type="password" name="passwd" value="" />
    // <input ... type="hidden" name="back" value="" />
    // <button ... type="submit" name="SubmitLogin"></button>
    formData: {
      email: username,
      passwd: password,
      back: '',
      SubmitLogin: ''
    },

    // The validate function will check if the login request was a success.
    // As lesptitscageots.fr returns a statucode=200 even if the authentification
    // goes wrong, we need to check the message returned on the webpage.
    validate: (statusCode, $) => {
      const errorMsg1 = `Adresse e-mail requise`
      const errorMsg2 = `Adresse e-mail invalide`
      const errorMsg3 = `Mot de passe requis`
      const errorMsg4 = `mot de passe non valable`
      const errorMsg5 = `&Eacute;chec d&#039;authentification` //Échec d'authentification
      if ($.html().includes(`Bienvenue sur votre page d'accueil.`)) {
        return true
      } else if ($.html().includes(errorMsg1)) {
        log('error', errorMsg1)
        return false
      } else if ($.html().includes(errorMsg2)) {
        log('error', errorMsg2)
        return false
      } else if ($.html().includes(errorMsg3)) {
        log('error', errorMsg3)
        return false
      } else if ($.html().includes(errorMsg4)) {
        log('error', errorMsg4)
        return false
      } else if ($.html().includes(errorMsg5)) {
        log('error', errorMsg5)
        return false
      } else {
        log('error', "erreur inconnue")
        return false
      }
    }
  })
}


// The goal of this function is to parse a HTML page wrapped by a cheerio instance
// and return an array of JS objects which will be saved to the cozy by saveBills
// (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
// cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
function parseDocuments($) {

  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      // The order date
      // <td data-value="20211021231457" class="history_date bold"></td>
      date: {
        sel: 'td.history_date',
        attr: 'data-value',
        parse: normalizeDate
      },
      // The order amount
      // <td class="history_price" data-value="86.15"></td>
      amount: {
        sel: 'td.history_price',
        attr: 'data-value',
        parse: parseFloat
      },
      // The order reference (not the invoice reference)
      // <td class="history_link bold"><a>DDVMDIJTQ</a></td>
      vendorRef: {
        sel: 'td.history_link a'
      },
      // The order status
      // It can be "Commande acceptée", "Commande traitée" or "Erreur de paiement"
      // <td class="history_state"><span>Commande traitée</span></td>
      orderStatus: {
        sel: 'td.history_state span',
      },
      // The invoice url
      // <td class="history_invoice"><a href="https://www.lesptitscageots.fr/index.php?controller=pdf-invoice&amp;id_order=129403"></a>
      fileurl: {
        sel: 'td.history_invoice a',
        attr: 'href'
      },
    },
    // <table id="order-list" class="table table-bordered footab">
    //   <tbody>
    //     <tr class="first_item ">
    'table#order-list tbody tr'
  )

  return docs
    // on filtre sur les commandes passées ou traitées
    // car les commandes annulées n'ont pas de facture.
    .filter(doc => doc.orderStatus === 'Commande passée'
                || doc.orderStatus === 'Commande traitée')

    // et on rajoute pour chacune les valeurs ci-dessous :
    .map(doc => ({
      ...doc,
      vendor: VENDOR,
      currency: 'EUR',
      filename: formatFilename(doc),
      fileAttributes: {
        metadata: {
          carbonCopy: true,
          classification: {
            label: 'food_invoice',
            purpose: 'invoice',
            sourceCategory: 'shopping'
          },
          datetime: utils.formatDate(doc.date),
          datetimeLabel: 'issueDate',
          contentAuthor: VENDOR,
          issueDate: utils.formatDate(doc.date)
        }
      }
    }))

}


/**
 * Converts a string formatted date (YYYYMMDDHHMMSS) into a JavaScript Date object.
 * @param {string} date
 * @returns {object Date}
*/
function normalizeDate(date) {
  return new Date(
    date.substring(0,4),      // year
    date.substring(4,6) - 1,  // month (javascript counts mounths from 0 to 11 !)
    date.substring(6,8),      // day
    date.substring(8,10),     // hour
    date.substring(10,12),    // minute
    date.substring(12,14)     // second
  )
}


/**
 * Formats the filename of the invoice based on its properties, such as:
 * 2021-01-01_les_ptits_cageots_facture_99.99EUR_ABCDEFJHI.pdf
 * @param {object} doc
 * @returns {string}
*/
function formatFilename(doc) {
  return `${utils.formatDate(doc.date)}_les_ptits_cageots_facture_${doc.amount.toFixed(2)}EUR_${doc.vendorRef}.pdf`
}
