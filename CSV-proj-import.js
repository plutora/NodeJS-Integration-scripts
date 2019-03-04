/**
 * Plutora Release Import from XLXS File
 *
 * Script By: Eldon Ahrold (eahrold@bigclubdigital.com)
 * Last Updated: 2019-02-26
 *
 * Notes:
 *   - Script REQUIRES the following Parameters
 *
 *       "plutora_host": String (e.g. "auapi.plutora.com"),
 *       "plutora_auth_host" : String (e.g "auoauth.plutora.com"),
 *       "plutora_username": String,
 *       "plutora_password": String (Masked),
 *       "plutora_client_id": String,
 *       "plutora_client_secret": String,
 *
 *       "sftp_host" : String (e.g. "sftp.us.plutora.com"),
 *       "sftp_user" : String,
 *       "sftp_pass" : String (Masked),
 *       "sftp_port" : String (e.g. "22"),
 *       'release_file' : String (e.g. "Project_View_data_SMALL.csv"),
 *
 */

const _ = require('lodash');
const https = require('https');
const querystring = require('querystring');
const ssh2 = require('ssh2');
const xlsx = require('xlsx');
const fs = require('fs');

const isDev = false;
const isDebug = false;

//----------------------------------------------------------
// Constants
//-------------------------------------------------------
const RELEASE_NAME_PREFIX = '(CSV IMPORT) '

const PPM_ID_KEY = 'Ppm Identifier (Ppm Rprt Prjct Golive Vw)'
const PPM_NAME_KEY = "Project Name"

/**
 * Only Update Releases whose implementation
 * dates are no greater that this many months back
 *
 * Note: This will only affect which items are updated,
 * the item will be created regardless of date
 *
 * @type {Number|false}
 */
const DO_NOT_UPDATE_IF_IMPLEMENTATION_DATE_IS_MORE_THAN_THIS_MANY_MONTHS_PAST = 2

/**
 * Roles to give to a release's stakeholders
 * added via this integration
 *
 * @type {Array}
 */
const RACI_STAKEHOLDER_ROLES = [
    "Project Manager"
]

/**
 * Filter
 * only rows where column header "Delivery IT Excomm"
 * that match a user in this array will be imported
 *
 * @type {Array}
 */
const FILTERED_DELIVERY_IT_EXCOMM_USERS = [
    "Simon King",
    "Rich Winslow"
]

/**
 * Filter
 * only rows where column header "Project Status"
 * that match a status in this array will be imported
 *
 * @type {Array}
 */
const FILTERED_PROJECT_STATUS = [
    "Project Execution",
]


/**
 * Some Messages
 * @type {Object}
 */
const EN_MESSAGES = {
    WELCOME: "Initializing Plutora API integration",
    ADDITIONAL_INFO_RELEASE_FIELDS_MISSING: "Additional Info fields were missing, or their names have changed. Please make sure the following fields exist [ :missing ]",
    INVALID_CSV_FILE: `The supplied file ":file" must be a valid CSV file. Please check it's formatting`,
}


/**
 * Additional Info Field Mappings
 *
 * Each Keys has an object the following properties
 * src: <String> the source key from a JSON Array
 * dest: <String> the Plutora Additional Info Field's "name" property
 * transformer: <Function> (optional) do a more complex transformation on, the function
 *              takes two parameters, value: the raw value for matched field, item: the full considered src object
 *
 * @type {Object}
 */
const ADDITIONAL_INFO_FIELD_MAPPINGS = {
    "PPM_ID": {
        src: PPM_ID_KEY,
        dest: "PPM ID",
    },

    "RELEASE_OWNER" : {
        src: RACI_STAKEHOLDER_ROLES,
        dest: "Release Owner"
    },

    "DELIVERY_SENIOR_DIRECTOR": {
        src: "Delivery Senior Director",
        dest: "Delivery Senior Director",
    },

    "DELIVERY_IT_EXCOMM" : {
        src: "Delivery It Excomm",
        dest: "Delivery IT Excomm",
    },

    "BRM_DIRECTOR" : {
        src: "Brm Director",
        dest: "BRM Director",
    },

    "GO_LIVE_DATE": {
        src: "Go Live Date",
        dest: "Go Live Date",
        transformer: function(value, item){

            // example value : "Dec-18"
            const parts = value.split('-')

            const month = function(monthStr){
                try {
                    var date = new Date(`${monthStr}-1`);
                    return date.getMonth()
                } catch(error){
                    return null
                }
            }(parts[0])

            const year = function(year){
                if (!year) return null;
                if (year.length === 4) {
                    return year
                }
                if(year.length === 2) {
                    return `20${year}`
                }
                return null
            }(parts[1])
            if (!year || !month) {
                return null
            }
            const date = new Date(Date.UTC(year, month, 1, 0, 0, 0))
            return date.toISOString()
        }
    },
}


//----------------------------------------------------------
// Global Helpers
//-------------------------------------------------------
// Dummy Mailer For Testing
const DummyMailer = {
    send: function(payload) {
        return new Promise((resolve, reject)=>{
            console.log("\n---------------- Pretending to sending mail ----------------\n")
            const { to, subject, cc } = payload
            console.log(`To: ${to}`)
            console.log(`Subject: ${subject}`)

            if (cc) console.log(`cc: ${cc}`)
            console.log(`\n${payload.body}\n`)
            console.log("---------------- Pretend mail send complete ----------------\n")

            resolve("Logged mailer module payload to console via DummyMailer adapter")
        })
    }
}

const IntegrationMailer = function() {
    try {
        if(_.isFunction(_.get(mailer, 'send'))) return mailer
        throw "Mailer Send is not a function or not available globally"
        // require('mailer')
    } catch(error) {
        console.error("Plutora Integration Mailer module not available, using Dummy Mailer as Fallback")
        return DummyMailer
    }
}()

/**
 * Iteration over an array waiting for the callback to complete
 * @param  {[type]}   array    [description]
 * @param  {Function} callback [description]
 */
const asyncForEach = async function(array, callback) {
    for (var index = 0; index < array.length; index++) {
        await callback(array[index], index, array)
    }
}

/**
 * Async Waiting utility
 * @param  {Number} wait Number of MS to wait
 * @return {Promise}     A promise to await
 */
const waiter = async function(wait=0) {
    return new Promise((resolve, reject)=>{
        if (wait <= 0) {
            return resolve()
        }
        setTimeout(()=>{
            resolve()
        }, wait)
    })
}

/**
 * Map a collection that requries await/async
 * @param  {Array}   array    Array of items
 * @param  {Function} callback [description]
 * @return {Array}            Mapped results
 */
const asyncMap = async function(array, callback) {
    const map = []
    for (var index = 0; index < array.length; index++) {
        const value = await callback(array[index], index)
        map.push(value)
    }
    return map
}

/**
 * Chunk a Group of Requests and execute according to API Limitations
 * @param  {array<Function>} array an array of functions that return a thenable when called
 * @param  {Number} size     The Number of items per chunk
 * @param  {Number} throttle The Number of ms to wait until a chunk has completed
 *
 * Note: the idea is that if the api can handle 6 calls/second you can chunk a
 * batches of 6 api requests, that will wait up to 1000ms before the next chunk is called.
 *
 * @return {array}          Fulfilled data from the request.
 */
const asyncMapChunked = async function(array, size=3, throttle=1000) {
    const chunks = _.chunk(array, size) 
    const total = chunks.length
    var count = 0

    return await asyncMap(chunks, async (chunk)=>{
        console.log(`Processing Chunk ${++count} of ${total} (size ${size})`)

        const start = new Date().getTime()
        const results = await Promise.all(chunk.map(c=>c()))
        const end = new Date().getTime()
        const wait = (start + throttle) - end
        if( wait > 0) {
            await waiter(wait)
        }
        return results
    })
    .then(_.flatMap)
}

/********************************************************
 ******* Run Plutora TEBR Mailer Integration  ***********
 ********************************************************/

const run = async function(args) {
    return new Promise(async (resolve, reject) => {

        const config = ConfigApi(args.arguments)

        const { plutora, customer } = config

        const Plutora = new PlutoraClient(
            plutora.server,
            plutora.auth
        )

        await Plutora.authenticate().then(() => {
            Logger.debug("AUTH_SUCCESS", { ...plutora.server, ...plutora.auth })
        }).catch((error) => {
            Logger.error("AUTH_FAILED", { ...plutora.server, ...plutora.auth }, true)
            reject(error)
        });

        const customer = new customerClient(
            customer.server,
            customer.auth
        )

        await customer.authenticate().then(() => {
            Logger.debug("AUTH_SUCCESS", { ...customer.server, ...customer.auth })
        }).catch((error) => {
            Logger.error("AUTH_FAILED", { ...customer.server, ...customer.auth }, true)
            reject(error)
        });


        const lastSuccessfulRun = function(args) {
            const lastRunTime = _.get(args, 'lastSuccessfulRunDateUtc') || null
            return new Date(lastRunTime)
        }(args)

        const integration = new Integration({Plutora, customer, config})

        try {
            await integration.run({lastSuccessfulRun,})
        } catch(error) {
            Logger.error("An Error Occurred while running the integration")
            Logger.error(error)
        }

        try {
            integration.log()
        } catch(error) {
            Logger.error("Error Logging Results")
            Logger.error(error)
        }

        if(integration.runFailed()) {
            return reject(-1)
        }

        resolve(0)
    });
};

class Integration {
    constructor ({Plutora, customer, config}) {

        if(!Plutora || !customer || !config) {
            throw "Integration Class requires {Plutora, customer, config} during construct"
        }
        this.RunResults = new RunResultsCollector()
        this.customer = customer

        this.Plutora = Plutora
        this.Plutora.setResultsCollector(this.RunResults)

        this.Lookup = {}
        this.config = config
    }

    async run({lastSuccessfulRun}) {

        await this.loadContextData()

        try {
            await this.processReleases({lastSuccessfulRun})
        } catch(error) {
            Logger.error(error);
            this.RunResults.markAsFailed("An error occurred while running the integration")
            this.RunResults.addError(error)
        }
    }

    log() {
        return this.RunResults.log()
    }

    runFailed() {
        return this.RunResults.failed()
    }

    //----------------------------------------------------------
    // Main Script
    //-------------------------------------------------------

    async loadContextData(){}

    setLookup(lookup) {
        return this.Lookup = {
            ...this.Lookup,
            ...lookup,
            __is_loaded__: true,
        }
    }

    async getLookup(options={reload: false}) {
        if(this.Lookup.__is_loaded__ && options.reload !== true) {
            return this.Lookup
        }
        return await this.loadLookupData();
    }

    async loadLookupData() {
        const { Plutora } = this;

        const lookupFieldNodes = await Plutora.getLookupFieldNodes([
            'ReleaseType',
            'ReleaseRiskLevel',
            'ReleaseStatusType',
            'StakeholderRole',
        ])


        const organizations = await Plutora.organizations()

        const organizationTop = _.find(organizations, { type: "Company" })
        if (! organizationTop) {
            console.error("Could not determine the top level organization, cannot continue with the script")
            throw "Unable to load required data"
        }

        const users = await Plutora.users()

        return this.setLookup({
            ...this.Lookup,
            organizations,
            organizationTop,
            users,
            ...lookupFieldNodes,
            __is_loaded__: true,
        })
    }

    async processReleases({lastSuccessfulRun}) {
        const { Plutora, customer, config } = this

        const csvFile = config.customer.release_file

        if(!_.endsWith(csvFile, '.csv')) {
            throw Lang.trans("INVALID_CSV_FILE", {file: csvFile})
        }

        const createResults = new RunResults("Releases", 'created')
        createResults.includeSuccessfulItemLines(true)

        const updateResults = new RunResults("Releases", 'updated')
        updateResults.includeSuccessfulItemLines(true)

        const data = await customer.releases(csvFile)
        const items = await this.filterReleasesForImport(data)

        const chunks = _.chunk(items, 25)


        const monthsPast = function(__force_update__) {
            if(__force_update__ === true) {
                return false
            }
            return DO_NOT_UPDATE_IF_IMPLEMENTATION_DATE_IS_MORE_THAN_THIS_MANY_MONTHS_PAST
        }(this.config.__force_update__)

        const doNotUpdatePastDate = function(date){
            if(monthsPast === false) {
                return (new Date(null))
            }
            if(_.isNumber(monthsPast) && monthsPast >= 0) {
                date.setMonth(date.getMonth()-monthsPast)
            }
            return date;
        }(new Date())

        await asyncForEach(chunks, async (items)=>{
            return this.processReleaseChunk(items, {createResults, updateResults, lastSuccessfulRun, doNotUpdatePastDate})
        })

        this.RunResults.addResults(createResults)
        this.RunResults.addResults(updateResults)
    }

    async processReleaseChunk(items, { createResults=null, updateResults=null, lastSuccessfulRun = new Date(), doNotUpdatePastDate= new Date(null)}) {

            createResults = createResults || new RunResults("Releases", 'created')
            updateResults = updateResults || new RunResults("Releases", 'updated')

            const releases = await this.mapItemsToReleases(items)

            const considerations = _.groupBy(releases,(release)=>{
                return release.id ? "update" : "create"
            })


            const doNotUpdatePastTime = doNotUpdatePastDate.getTime();

            await asyncForEach(considerations.create || [], async(release)=>{
                return this.createRelease(release).then((_release_)=>{
                    createResults.addSuccess(`Created Release "${release.name}"`)
                }).catch(error=>{
                    Logger.error(error)
                    createResults.addError(`Error Creating Release "${release.name}"`)
                })
            })

            await asyncForEach(considerations.update || [], async(release)=>{
                if((new Date(release.implementationDate).getTime() < doNotUpdatePastTime)) {
                    return updateResults.addSkipped(`Skipped updating release "${release.name}" due to implementation date before ${doNotUpdatePastDate}`)
                }

                return this.updateRelease(release).then((_release_)=>{
                    updateResults.addSuccess(`Updated Release "${release.name}"`)
                }).catch(error=>{
                    Logger.error(error)
                    updateResults.addError(`Error Updating Release "${release.name}"`)
                })
            })
    }

    //----------------------------------------------------------
    // Loading Phase
    //-------------------------------------------------------
    async filterReleasesForImport(releases) {
        return _.filter(releases, (release)=>{
            var person = release['Delivery It Excomm']
            var status = release['Project Status']

            return FILTERED_DELIVERY_IT_EXCOMM_USERS.includes(person) &&
               FILTERED_PROJECT_STATUS.includes(status)
        })
    }


    //----------------------------------------------------------
    // Mapping Phase
    //-------------------------------------------------------
    verifyReleaseAdditionalInfoFields(additionalInformationFields) {
        const expectedPlutoraKeys = _.sortBy(_.values(ADDITIONAL_INFO_FIELD_MAPPINGS).map(f=>f.dest))
        const existingPlutoraKeys = _.sortBy(additionalInformationFields.map(f=>f.name))

        const missing = _.difference(expectedPlutoraKeys, existingPlutoraKeys)
        const passes =  missing.length === 0;

        if (!passes) {
            Logger.error(`The follwoing AI Release Fields are missing - [ ${missing} ]`)
            const message = Lang.trans("ADDITIONAL_INFO_RELEASE_FIELDS_MISSING", { missing: missing })
            this.RunResults.addError(message);
        }
        return passes
    }

    async mapItemsToReleases(items) {
        const { Plutora } = this;

        const additionalInformationFields = await Plutora.availableAdditionalInfoFieldsForRelease()
        if ( !this.verifyReleaseAdditionalInfoFields(additionalInformationFields) ) {
            throw "There was an issue mapping the data to Plutora Releases"
        }

        const Lookup = await this.getLookup()
        const existingIds = _.map(items, (item)=>{
            return _.get(item, [PPM_ID_KEY])
        })

        const existing = await Plutora.findReleasesByAttribute(existingIds, 'identifier').then(releases=>{
            return _.keyBy(releases, 'identifier')
        })

        const releases = await asyncMap(items, async (item)=>{
            const key = _.get(item, [PPM_ID_KEY]);
            const match = _.get(existing, key, null);

            return await this.mapItemToRelease(item, {additionalInformationFields, Lookup, match })
        })

        return releases
    }

    mapReleaseImplementationDate(srcDateStr) {
        // Example Value "10/1/18 0:00"
        var date = (new Date(srcDateStr))

        // From Requirements doc
        // If month/Year received use first day of month/same year
        date.setDate(1)

        return date.toISOString()
    }

    mapReleaseStakeholders(item, Lookup) {
        const users = _.get(item, 'Project Manager')
            .split(',')
            .map((userName)=>{
                const name = _.trim(userName)
                const parts = _.filter(name.split(' '));
                const firstName = _.first(parts)
                const lastName = _.last(parts)
                const fullName = `${firstName} ${lastName}`.toLowerCase()

                return _.find(Lookup.users, (user)=>{
                    const compare = `${user.firstName} ${user.lastName}`.toLowerCase()
                    return compare == fullName
                })
            })
            .filter(i=>!_.isEmpty(i))

        const stakeholderRoleIds = _(Lookup.StakeholderRole).filter(role=>{
            return RACI_STAKEHOLDER_ROLES.includes(role.value);
        })
        .map(r=>r.id)
        .value();

        return _.map(users, (user, idx)=>{
            return {
              "userId": user.id,
              "stakeholderRoleIds": stakeholderRoleIds,
              "accountable": idx === 0 ? true : false,
              "responsible": true,
              "informed": true,
              "consulted": true
            }
        })
    }

    __aiValueKey(field) {
        switch (field.dataType) {
            case "Number": return "number"
            case "ListSelect": return 'multiListItem'
            case "FreeText": return "text"
            case "Decimal": return "decimal"
            case "DateTimePicker": return "dateTime"
            case "DatePicker": return "date"
            case "TimePicker": return "time"
            case "ListField": return "listItem"
            default: return "text"
        }
    }

    mapReleaseAdditionalInfo(item, additionalInformationFields) {
        return _.transform(ADDITIONAL_INFO_FIELD_MAPPINGS, (map, value, key)=>{
            const field = _.find(additionalInformationFields, {name: value.dest})
            if (field) {
                const valueKey = this.__aiValueKey(field)
                const rawValue = _.get(item, value.src)
                const transformer = _.get(value, 'transformer', r=>r)

                map.push({
                    ...field,
                    [valueKey] : transformer(rawValue)
                })
            }
            return map
        }, [])
    }

    findOrganizationIdForRelease(sponsoringOrg, Lookup) {
        const organizationId = _.get(Lookup, [
            'organizations',
            sponsoringOrg,
        ], Lookup.organizationTop).id

        return organizationId
    }

    async mapItemToRelease(item, { additionalInformationFields, Lookup, match }) {

        const releaseTypeId = this.keyOrFirst(Lookup.ReleaseType, "Project", (key, using)=>{
            Logger.warning(`Failed Finding Release Type "${key}" using "${using}" as Fallback`)
        }).id

        const releaseStatusTypeId = this.keyOrFirst(Lookup.ReleaseStatusType, "Draft", (key, using)=>{
            Logger.warning(`Failed Finding Release Status Type "${key}" using "${using}" as Fallback`)
        }).id

        const releaseRiskLevelId = this.keyOrFirst(Lookup.ReleaseRiskLevel, "Medium", (key, using)=>{
            Logger.warning(`Failed Finding Release Risk Level Status Type "${key}" using "${using}" as Fallback`)
        }).id


        const existing = !_.isEmpty(match) ? match : {
            "displayColor": "#fff",
            "plutoraReleaseType": "Independent",
            "releaseProjectType": "IsProject", //"NotIsProject",
        }

        const stakeholders = this.mapReleaseStakeholders(item, Lookup)

        return {
            ...existing,
            "identifier": item[PPM_ID_KEY],
            "name": RELEASE_NAME_PREFIX + _.get(item, [PPM_NAME_KEY], "Missing Name"),
            "summary": _.get(item, ["Prj Short Description"], ""),

            "additionalInformation": this.mapReleaseAdditionalInfo(item, additionalInformationFields),
            "implementationDate": this.mapReleaseImplementationDate(item['Planned Finish Period']),
            "organizationId": this.findOrganizationIdForRelease(item["Sponsoring Org"], Lookup),

            "plutoraReleaseType": "Independent",
            "releaseProjectType": "IsProject", //"NotIsProject",

            releaseTypeId,
            releaseStatusTypeId,
            releaseRiskLevelId,

            __pending: {
                stakeholders,
            }

        }
    }

    //----------------------------------------------------------
    // Creation Phase
    //-------------------------------------------------------
    async createRelease(newRelease) {
        Logger.log(`Creating Release ${newRelease.name}`)

        const { Plutora } = this

        const { stakeholders } = newRelease.__pending
        const release = await Plutora.createRelease(_.omit(newRelease, '__pending', 'id'))
        await Plutora.addReleaseStakeholders(release.id, stakeholders)

        return {
            ...release,
            stakeholders,
        }
    }

    async updateRelease(updateRelease) {
        Logger.log(`Updating Release ${updateRelease.name}`)

        const { Plutora } = this

        const { stakeholders } = updateRelease.__pending
        const release = await Plutora.updateRelease(_.omit(updateRelease, '__pending'))

        await Plutora.upsertReleaseStakeholders(release.id, stakeholders)

        return {
            ...release,
            stakeholders,
        }
    }

    //----------------------------------------------------------
    // Util
    //-------------------------------------------------------
    keyOrFirst(source, key, failedMessage=()=>{}, defaultFallbackKey) {
        const result = _.get(source, key)
        if(result) return result;

        const defaultFound = _.has(source, defaultFallbackKey)
        const using = defaultFound ? defaultFallbackKey : _.keys(source)[0]
        const fallback = source[using]
        const alt = failedMessage(key, using)
        if (alt !== undefined) { return alt }

        return fallback
    }

}

const ConfigApi = function(env) {
    return {
        plutora: {
            server: {
                hostname: env.plutora_host,
                port: 443,
            },
            auth: {
                server: {
                    hostname: env.plutora_auth_host,
                    endpoint: '/oauth/token'
                },
                client_id: env.plutora_client_id,
                client_secret: env.plutora_client_secret,
                grant_type: "password",
                username: env.plutora_username,
                password: env.plutora_password,
            },
        },

        customer: {
            release_file: `${env.customer_release_file}`,

            server: {
                hostname: `${env.customer_sftp_host}`,
                port: 22,
            },

            auth: {
                username: `${env.customer_sftp_user}`,
                password: `${env.customer_sftp_pass}`,
            }
        },

        __force_update__: env.__force_update__ === "true"
    }
};

class RunResultsCollector {
    constructor() {
        this.reset()
    }

    reset() {
        this.__results = []
        this.__errors = []
        this.__start_time = new Date()
        this.__requests = {}
        this.__has_failed = false
        this.__internal_failure_reason = "An error occurred during the integration run process"
    }

    failureReason(reason) {
        return this.__internal_failure_reason
    }

    markAsFailed(reason="") {
        this.__has_failed = true
        if (_.isString(reason) && !_.isEmpty(reason)) {
            this.__internal_failure_reason = reason
            this.addError(reason)
        }
        return this
    }

    requestMade(type, description) {
        if(!_.isArray(_.get(this.__requests, type))) {
            this.__requests[type] = []
        }
        this.__requests[type].push(description)
    }

    addResults(results) {
        if(results instanceof RunResults) {
            this.__results.push(results)
        }
    }

    addError(error) {
        this.__errors.push(error)
        return this
    }

    sendMail() {
        // Mailer not implemented
    }

    success() {
        return !this.failed()
    }

    failed() {
        return this.__has_failed || _.filter(this.__results, (result)=>{
            return result.failed()
        }).length > 0
    }

    hasFailures() {
        return _.filter(this.__results, (result)=>{
            return result.hasFailures()
        }).length > 0
    }

    failedCount() {
        return this.__results.reduce((map, result)=>{
            return map = map + result.failed.length
        }, 0)
    }

    successCount() {
        return this.__results.reduce((map, result)=>{
            return map = map + result.success.length
        }, 0)
    }

    log() {
        console.log(this.lines().join('\n'))
    }

    lines() {

        const failuresStr = this.hasFailures() ? `WITH ${this.failedCount()} FAILURES ` : ``
        const status = this.failed() ? "FAILED" : "SUCCESS"

        const requestsMade = _.map(this.__requests, (requests, type)=>{
            return `${requests.length} ${type} HTTP Requests were made`
        })

        const hasErrors = this.__errors.length

        const lines = [
            ``,
            _.padEnd(`================================================= Integration Run Complete ${failuresStr}=`, 100, '='),
            `Run Started: ${this.__start_time}`,
            `Run Completed ${new Date()}`,
            `STATUS: ${status}`,
            ``,
            `Successful Processed ${this.successCount()} items total`,
            ...requestsMade,
            (hasErrors ? `There were ${this.__errors.length} global errors encountered` : ""),
            ...(hasErrors ? this.__errors.map(e=>`  - ${JSON.stringify(e)}`) : []),
            ``
        ]


        const r_lines = this.__results.map(result=>{
            return result.getLines()
        })

        return [
            ...lines,
            ...r_lines
        ]
    }
}

class RunResults {

    constructor(type, action, indicatesFailure=true) {
        this.type = type;
        this.action = action;

        this.messages = { intro: [], outro: []}

        this.success = []
        this.failures = []
        this.skipped = []
        this.errors = []

        this.log_succes_items = true;
        this.log_failed_items = true;
        this.log_skipped_items = true;
        this.indicates_global_failure = indicatesFailure
    }

    failed() {
        return this.indicates_global_failure && this.failures.length > 0
    }

    succeeded() {
        return !this.failures
    }

    includeSuccessfulItemLines(status=true) {
        if(_.isBoolean(status)){
            this.log_succes_items = status
        }

        return this
    }

    includeFailedItemLines(status=true) {
        if(_.isBoolean(status)){
            this.log_failed_items = status
        }

        return this
    }

    addIntroMessage(message) {
        if(!_.isString(message)) return;
        this.messages.intro.push(message)
        return this
    }

    addOutroMessage(message) {
        if(!_.isString(message)) return;
        this.messages.outro.push(message)
        return this
    }

    addSuccess(description) {
        if(!_.isString(description)) return;
        this.success.push({description})
        return this
    }

    addFailure(description, error) {
        if(!_.isString(description)) return;
        this.failures.push({description, error})
        return this
    }

    addSkipped(description) {
        if(!_.isString(description)) return;
        this.skipped.push({description})
        return this
    }

    addError(error) {
        this.errors.push(error)
        return this
    }

    hasErrors() {
        return this.errors.length > 0
    }

    hasFailures() {
        return this.failures.length > 0
    }

    getLines() {
        const header = _.padEnd(`------------------------------------### ${this.type} ${this.action} Results ###-`, 100, '-')
        const footer = '|'

        return [
            header,
            ..._.map(this.messages.intro, message=>`| ${message}`),

            `| Successful ${this.action} ${this.success.length} items`,
            ...(this.log_succes_items ? _.map(this.success, item=>`|  - item: ${item.description}`) : []),

            `| Skipped ${this.action} ${this.skipped.length} items`,
            ...(this.log_skipped_items ? _.map(this.skipped, item=>`|  - item: ${item.description}`) : []),

            `| Failed ${this.action} ${this.failures.length} items`,
            ...(this.log_failed_items ? _.map(this.failed, item=>`|  - item: ${item.description}`) : []),

            `| Errors Encountered ${this.errors.length} :`,
            ..._.map(this.errors, error=>`|  - ${JSON.stringify(error)}`),
            ..._.map(this.messages.outro, message=>`| ${message}`),
            footer,
        ].join('\n')
    }

    log() {
        const lines = this.getLines()
        console.log(lines)
    }
}

class customerClient {
    constructor(server, auth) {
        const { hostname, port } = server
        const { username, password } = auth
        this.hostname = hostname
        this.username = username
        this.password = password
        this.port = 22
    }

    sshParams() {
        return {
          host: this.hostname,
          port: this.port,
          username: this.username,
          password: this.password,
        }
    }

    async authenticate() {
        const self = this
        return new Promise((resolve, reject) => {
            const conn = new ssh2.Client();
            conn.on('ready', function () {
              conn.sftp(function (err, sftp) {
                conn.end();
                err ? reject(err) : resolve(self);
              });
            }).connect(this.sshParams());
        }).catch(error=>{
            console.log("Logging Into customer Server", error)
            throw error
        })
    }

    parseCsv(str) {
        // Implementation from https://stackoverflow.com/a/14991797/2127446
        var arr = [];
        var quote = false;
        for (var row = 0, col = 0, c = 0; c < str.length; c++) {
            var cc = str[c], nc = str[c+1];
            arr[row] = arr[row] || [];
            arr[row][col] = arr[row][col] || '';
            if (cc == '"' && quote && nc == '"') { arr[row][col] += cc; ++c; continue; }
            if (cc == '"') { quote = !quote; continue; }
            if (cc == ',' && !quote) { ++col; continue; }
            if (cc == '\r' && nc == '\n' && !quote) { ++row; col = 0; ++c; continue; }
            if (cc == '\n' && !quote) { ++row; col = 0; continue; }
            if (cc == '\r' && !quote) { ++row; col = 0; continue; }
            arr[row][col] += cc;
        }
        return arr;
    }

    async _convertCsvFileToJson(filePath) {
        return new Promise((resolve, reject)=>{
            fs.readFile(filePath, 'utf8', (err, contents)=>{
                if (err) {
                    return reject(err)
                }
                const cleaned = contents.replace(/^\uFEFF/, '');
                const results = this.parseCsv(cleaned)
                const headers = results.shift()

                const json = results.map((row)=>{
                    return row.reduce((map, value, idx)=>{
                        map[_.trim(headers[idx])] = _.trim(value)
                        return map
                    }, {})
                })

                resolve(json)
            });
        })
    }

    async _convertXlsxFileToJson(filePath) {
        console.log(`parsing file ${filePath}.`);
        const result = xlsx.readFile(filePath);
        return xlsx.utils.sheet_to_json(result.Sheets[result.SheetNames[0]]);
    }


    async downloadSshFile(sshFilePath, filePath) {
      return new Promise((resolve, reject) => {

        var conn = new ssh2.Client();
        conn.on('ready', function () {
          conn.sftp(function (err, sftp) {
            if (err) {
              conn.end();
              reject(err);
            }

            const opts = { concurrency: 64, chunkSize: 32768 };
            sftp.fastGet(sshFilePath, filePath, opts, (err) => {
              conn.end();

              if (err) {
                reject(err);
              }
              resolve(filePath);
            });
          });
        }).connect(this.sshParams());
      });
    }

    async releases(file) {
        const filePath = await this.downloadSshFile(file, './__release.csv')
        const json = await this._convertCsvFileToJson(filePath)
        return json
    }

}

/**
 * Restable Abstract Class
 *
 * Provides a common interface for
 * get, post, put, delete
 *
 */
class Restable {
    /**
     * construct
     * @param  {Object} server { hostname, path, port }
     * @param  {object} auth   varies based on Authenticator
     * @return {this}
     */
    constructor(server, auth) {
        const { hostname, path, port } = server

        this.hostname = hostname
        this.path = path
        this.port = port

        this.authenticator = this.__make_authenticator(auth)

        this.throttle = 0
        this.parseUrl = parseUrl
    }

    setResultsCollector(resultsCollector) {
        this.__adapter.setResultsCollector(resultsCollector, this.constructor.name)
        return this
    }

    getHeaders() {
        return this.__adapter.headers;
    }

    async authenticate() {
        return this.authenticator.authenticate().then(({ message, adapter }) => {
            this.__adapter = this.__init_adapter(adapter)
            return this
        });
    }


    async keyJsonArray(json, key) {
        return json.reduce(function(map, obj) {
            map[obj[key]] = obj;
            return map;
        }, {});
    }

    async map(array, callback) {
        const map = []
        for (var index = 0; index < array.length; index++) {
            const value = await callback(array[index], index)
            map.push(value)
        }
        return map
    };

    async raw(endpoint, params) {
        return this.__adapter.get(endpoint, params)
    }

    async getJson(endpoint, params) {
        return this.__adapter.get(endpoint, params).then(response=>{
            return response.json()
        })
    }

    async get(endpoint, params) {
        return this.__adapter.get(endpoint, params)
    }

    async post(endpoint, params) {
        return this.__adapter.post(endpoint, params)
    }

    async put(endpoint, params) {
        return this.__adapter.put(endpoint, params)
    }

    __make_authenticator(auth) {
        return new Authenticator(auth)
    }

    __init_adapter(adapter) {
        return new HttpsAdapter({
            hostname: this.hostname,
            path: this.path,
            port: this.port,
            throttle: this.throttle,
            adapter,
        })
    }

    __pathAppendingQueryString(path, query) {
        // Exit early if there's nothing to append
        if (!(params instanceof Object) ||
            !(Object.keys(params).length)) {
            return path
        }
        return `${path}?${Object.keys(params).map(function(key){
            return `${key}=${params[key]}`
        }).join('&')}`;
    }

    _parseRoute(route, opts={}) {
        Object.keys(opts).forEach(function(key) {
            route = route.replace(`:${key}`, opts[key])
        })
        return route
    }
}

//----------------------------------------------------------
// Plutora Api Elements
//-------------------------------------------------------

const PlutoraFilters = {
    make: function(searchFilters = [], recordsPerPage=50, pageNum=0) {
        return {
         searchFilters,
         recordsPerPage,
         pageNum
        }
    },

    makeFindingLatest: function(searchFilters = []) {
        return {
            searchFilters: [
                this.latest(),
                ...searchFilters,
            ],
            recordsPerPage: 0,
            pageNum: 0
        }
    },

    latest: ()=>{
        return {
             "property": "lastModifiedDate",
             "direction": "DESC",
             "value": new Date('1979').toISOString(),
             "operator": "GreaterThan",
        }
    },

    whereStartsWith: (propery, value, direction='ASC')=>{
        return {
            "direction": direction,
            "property": propery,
            "value": value,
            "operator": "StartsWith",
        }
    },

    modifiedSince: (date, direction='ASC')=>{
        return {
            "direction": direction,
            "property": 'lastModifiedDate',
            "value": date.toISOString(),
            "operator": "GreaterOrEqual",
        }
    },

    raisedBy:(user, direction='ASC')=>{
        return {
            "direction": direction,
            "property": 'raisedBy',
            "value": user,
            "operator": "Equals",
        }
    },


    isWithin: (property, values=[], direction='ASC')=>{
        return {
            property,
            direction,
            "value": values.join(','),
            "operator": "IsWithin",
        }
    },
}

/**
 * Plutora Endpoints
 * @type {Object}
 */
const PlutoraEndpoints = {
    ME: "/me",
    ORGANIZATIONS: "/organizations",

    USERS: "/users",
    // USER: "/users/:userId",

    TEBRs: '/TEBRs',
    TEBR: "/TEBRs/:tebrId",

    RELEASES: '/releases',
    RELEASE: "/releases/:releaseId",
    RELEASE_STAKEHOLDERS: "/releases/:releaseId/stakeholders",

    COMMENTS: '/comments/:type/:id',

    LOOKUP_TYPE: '/lookupfields/:type',
}

/**
 * Plutora Api Client
 */
class PlutoraClient extends Restable {

    constructor(server, auth) {
        super(server, auth)
        this.throttle = 1000
    }

    //----------------------------------------------------------
    // Util
    //-------------------------------------------------------
    async aggregateJson(endpoint, results=[], params = {pageNum:0, recordsPerPage:25, filters: null}) {
        const { pageNum, recordsPerPage } = params
        let query = `pageNum=${pageNum}&recordsPerPage=${recordsPerPage}`

        return this.getJson(`${endpoint}?${query}`).then(newResults=>{
            const aggregate = [].concat(results, newResults);
            if(newResults < recordsPerPage) {
                return aggregate
            }
            return this.aggregateJson(endpoint, aggregate, {pageNum: pageNum+1, recordsPerPage})
        })
    }

    async aggregateFilteredResultsSet(endpoint, filter, results, aggregate=[]) {
        if(results.returnCount === 0 || results.returnCount === results.totalCount) {
            return aggregate
        }
        const newFilter = {
            ...filter,
            pageNum: filter.pageNum + 1
        }
        const more = await this.post(endpoint, newFilter).then(response=>response.json())
        return this.aggregateFilteredResultsSet(endpoint, newFilter, more, [
            ...aggregate,
            ...more.resultSet
        ])
    }

    //----------------------------------------------------------
    // Releases
    //-------------------------------------------------------
    async createRelease(payload) {
        const endpoint = PlutoraEndpoints.RELEASES
        return this.post(endpoint, payload).then(r=>r.json())
    }

    async updateRelease(payload) {
        const releaseId = payload.id
        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })
        return this.put(endpoint, payload)
            .then(r=>{
                // PUT returns 204 <No Content>
                return payload
            })
    }

    async addReleaseStakeholders(releaseId, stakeholders) {
        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE_STAKEHOLDERS, { releaseId, })
        return this.map(stakeholders, async (stakeholder)=>{
            return this.post(endpoint, stakeholder).then(r=>r.json())
        })
    }

    async updateReleaseStakeholders(releaseId, stakeholders) {
        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE_STAKEHOLDERS, { releaseId, })
        return this.map(stakeholders, async (stakeholder)=>{
            return this.put(`${endpoint}/${stakeholder.userId}`, stakeholder).then(r=>{
                // PUT returns 204 <No Content>
                return stakeholder
            })
        })
    }

    async upsertReleaseStakeholders(releaseId, stakeholders) {
        if (_.isEmpty(stakeholders)) return [];

        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE_STAKEHOLDERS, { releaseId, })
        const existing = await this.getJson(endpoint);
        const existingUserIds = _.map(existing, stakeholder=>stakeholder.userId)

        const considerations = _.groupBy(stakeholders, (stakeholder)=>{
            return existingUserIds.includes(stakeholder.userId) ? "update" : "add"
        })

        const added = await this.addReleaseStakeholders(releaseId, considerations.add)
        const updated = await this.addReleaseStakeholders(releaseId, considerations.update)

        return [].concat(added, updated)
    }

    //----------------------------------------------------------
    // Features
    //-------------------------------------------------------
    async organizations() {
        const endpoint = PlutoraEndpoints.ORGANIZATIONS
        return this.aggregateJson(endpoint)
    }

    async users() {
        const endpoint = PlutoraEndpoints.USERS
        return this.aggregateJson(endpoint)
    }

    async findReleasesByAttribute(ids=[], attribute='identifier'){
        if (ids.length > 25) {
            throw "You Cannot Lookup more that 25 items at a time"
        }

        if (ids.length === 0) {
            return []
        }

        const filters = _.map(ids, (id)=>{
             return `\`${attribute}\` Equals \`${id }\``
        }).join(' or ')

        let query = `filter=${querystring.escape(filters)}`

        return this.getJson(`${PlutoraEndpoints.RELEASES}?${query}`)
    }

    async availableAdditionalInfoFieldsForRelease() {

        const endpoint = `${PlutoraEndpoints.RELEASES}?pageNum=0&recordsPerPage=1`
        return await this.getJson(endpoint).then(results=>{
            if(!results.length) {
                throw "There are not releases currently, please create on to use as a template for additionalInformation fields"
            }

            const release = results[0]
            const aIendpoint = this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId: release.id })
            return this.loadAdditionalInfoFor(aIendpoint).then(fields=>{
                return _.map(fields, (field)=>{
                    // We do this to ensure incorrect values
                    // are not accidently passed across.
                    return {
                        ...field,
                        "text": null,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    }
                })
            })
        })
    }

    //----------------------------------------------------------
    // Lookup
    //-------------------------------------------------------
    async getLookupFieldNodes(types) {
        const promises = types.map((type)=>{
            return this.getLookupFields(type)
        })

        return Promise.all(promises).then((all)=>{
            return _.transform(types, function(map, key, idx){
                return map[key] = all[idx]
            }, {})
        })
    }


    //Get the list of valid values of all LookUpFields for the Release entity in Plutora
    async getLookupFields(type) {
        const endpoint = this._parseRoute(PlutoraEndpoints.LOOKUP_TYPE, { type, })
        return this.getJson(endpoint).then((response) => {
            return _.keyBy(response, 'value')
        });
    };

    //----------------------------------------------------------
    // Additional Info Loader
    //-------------------------------------------------------

    async loadAdditionalInfoFor(endpoint) {
        return this.get(`${endpoint}/additionalInformation`).then(response=>{
            return response.json()
        })
    }

    async loadCommentsFor(type, id) {
        const endpoint = this._parseRoute(PlutoraEndpoints.COMMENTS, { type, id, })
        return this.get(endpoint).then(response=>{
            return response.json()
        })
    }
}



/**
 * Language Utility Object
 * @type {Object}
 */
const Lang = {
    local: 'en',

    en: EN_MESSAGES,

    _exec(str, opts) {
        var message = str
        Object.keys(opts).forEach(function(key) {
            const value = (!_.isNil(opts[key]) && !_.isObject(opts[key])) ? opts[key] : ""
            message = message.replace(`:${key}`, value)
        })
        return message
    },

    logTrans(message, sub = {}) {
        const now = new Date().toISOString()
        const mgs = _.padEnd(_.get(sub, 'log_type', "???"), 6)
        // const timestamp = `[ ${now} ] ${mgs} | `
        const timestamp = `${mgs} | `
        return `${timestamp}${this.trans(message, sub)}`
    },

    trans(message, sub = {}) {
        return this._exec(
            _.get(this, [this.local, message], message),
            sub
        )
    },
}

/**
 * Logging Utility
 * @type {Object}
 */
const Logger = {
    isDebug: isDebug,
    isDev: isDev,

    disableDebug() {
        this.isDebug = false
    },

    enableDebug() {
        this.isDebug = true
    },

    debug() {
        if (this.isDebug) {
            console.trace(...arguments)
        }
    },

    dev() {
        if(this.isDev) {
            console.trace(...arguments)
        }
    },

    log() {
        console.log(...arguments)
    },

    info() {
        console.info(...arguments)
    },

    warning() {
        console.warn(...arguments)
    },

    error() {
        console.error(...arguments)
    },

}

/**
 * Parse A URL into an object
 * @param  {string} url The URL String
 * @return {Object}     url object similar to one returned from node's url.parse()
 */
const parseUrl = function(url) {
    var match = url.match(/^(http|https|ftp)?(?:[\:\/]*)([a-z0-9\.-]*)(?:\:([0-9]+))?(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i);
    var ret   = new Object();

    ret['protocol'] = '';
    ret['hostname']     = match[2];
    ret['port']     = '';
    ret['pathname']     = '';
    ret['search']     = '?';
    ret['query']    = '';
    ret['fragment'] = '';

    if(match[1]){
        ret['protocol'] = match[1];
    }

    if(match[3]){
        ret['port']     = match[3];
    }

    if(match[4]){
        ret['pathname'] = `${match[4]}`;
    }

    if(match[5]){
        ret['query']    = match[5];
        ret['search']   = `?${match[5]}`
    }

    if(match[6]){
        ret['fragment'] = match[6];
    }

    return ret;
}

/**
 * Https Adapter
 *
 * This was more necissary when there was discussion
 * as to allow the request's lib, which
 * would have provided an alternate adapter
 * to the Restable class, and probably
 * could be refactored out.
 */
class HttpsAdapter {
    constructor({ hostname, adapter, path, throttle }) {
        const { headers } = adapter

        this.hostname = hostname
        this.headers = headers
        this.prefix = path

        this._maxRedirects = 3
        this._throttle = _.isNumber(throttle) ? throttle : 0
    }

    setThrottle(ms) {
        if(_.isNumber(ms)){
            this._throttle = 0
        }
        return this
    }

    setResultsCollector(resultsCollector, type) {
        this._resultsCollector = resultsCollector
        this._resultsCollector_type = type
    }

    __madeRequest(options) {
        if (this._resultsCollector && this._resultsCollector_type) {
            this._resultsCollector.requestMade(this._resultsCollector_type, options)
        }
    }

    __pathAppendingQueryString(path, params) {
        // Exit early if there's nothing to append
        if (!(params instanceof Object) ||
            !(Object.keys(params).length)) {
            return path
        }

        return `${path}?${Object.keys(params).map(function(key){
            return `${key}=${params[key]}`
        }).join('&')}`;
    }

    __buildRequestOptions(config) {
        const { hostname, headers } = this
        return {
            ...config,
            hostname,
            headers,
        }
    }

    __prefixedPath(path) {
        const prefix = _.get(this, 'prefix', false)
        if (!_.isString(prefix) || _.isEmpty(prefix)) return path
        return `/${_.trim(prefix, '/')}/${_.trimStart(path,'/')}`
    }

    __reset() { /* Not Currently Used */}

    async _raw_request_(endpoint, x_params, __config) {
        var __redirectCount = _.get(__config, "__redirectCount", 0)
        const aUrl = parseUrl(endpoint)

        const options = {
            hostname: aUrl.hostname,
            path: `${aUrl.pathname}${aUrl.search}`,
            method: 'GET',
            headers: this.headers,
            __redirectCount,
        };

        return this.makeRequest(options, {})
    }

    async __followRedirect(response, config={}) {
        let __redirectCount = config.__redirectCount || 0

        if (++__redirectCount > this._maxRedirects) {
            throw "Too Many Redirects";
        }

        let location = response.redirectTo()
        Logger.dev("[ DEV ] Redirecting To", { location })

        return this._raw_request_(location, null, {__redirectCount})
    }

    __logResponse(options, response) {
        const now = (new Date()).toISOString()
        const url = `https://${options.hostname}${options.path}`

        if(response.isError()) {
            Logger.error(
                Lang.logTrans(`Response: ${response.status()} ERROR | ${url}`, {log_type: `HTTPS`})
            )
            Logger.error(
                '\n',
                '-------------------- Begin Error Response Body --------------------\n',
                response.body,
                '\n--------------------- End Error Response Body ---------------------\n'
            )
        }
        else if (response.isRedirect()) {
            Logger.error(
                Lang.logTrans(`Response: ${response.status()} REDIRECT | ${options.path}`, {log_type: `HTTPS`})
            )
        }
        else {
            Logger.log(
                Lang.logTrans(`Response: ${response.status()} OK | ${url}`, {log_type: `HTTPS`})
            )
        }
    }

    async makeRequest(options, data = {}) {
        const payload = !!Object.keys(data).length ? JSON.stringify(data) : ""

        return new Promise((resolve, reject) => {
            const startTime = (new Date()).getTime();

            this.__madeRequest(options)

            const req = https.request(options, (res) => {
                let body = "";
                res.on("data", data => {
                    body += data;
                });

                res.on("end", async() => {
                    const response = new Response(body, res.statusCode, res.headers)
                    this.__logResponse(options, response)

                    if (response.isRedirect()) {
                        var __redirectCount = _.get(options, '__redirectCount', 0)
                        return this.__followRedirect(response, {__redirectCount}).then(redirectResponse => {
                            resolve(redirectResponse)
                        })
                    }


                    // This is painful, but as of 2019/02/11
                    // the API throttle is behaving differently
                    // and 6/s is getting STRICTLY enforced.
                    // we need to make sure absolutely
                    // every single request is waited on
                    // for at least a second, so not to accidently
                    // go over, when the api is able to respond
                    // successfully and quickly
                    if(this._throttle > 0) {
                        const end = (new Date()).getTime()
                        const wait = (startTime + this._throttle) - end
                        if( wait > 0 ) {
                            await waiter(wait)
                        }
                    }

                    if (response.isSuccess()) {
                        resolve(response);
                    } else {
                        reject(response);
                    }

                    this.__reset()
                });
            });

            req.on('error', (error) => {
                const message = `Requset Error https://${options.hostname}/${options.path}`;
                var response = new Response(JSON.stringify({ message, error }), 500, {})
                reject(response);
            });

            req.write(payload);
            req.end();
        });
    };

    async get(endpoint, params) {
        const path = this.__pathAppendingQueryString(endpoint, params)

        const options = this.__buildRequestOptions({
            method: "GET",
            path: this.__prefixedPath(path)
        })
        return this.makeRequest(options)
    }

    async post(endpoint, params) {
        const options = this.__buildRequestOptions({
            method: "POST",
            path: this.__prefixedPath(endpoint)
        })
        return this.makeRequest(options, params)
    }

    async put(endpoint, params) {
        const options = this.__buildRequestOptions({
            method: "PUT",
            path: this.__prefixedPath(endpoint)
        })
        return this.makeRequest(options, params)
    }
}

/**
 * Authenticator Class For any Sane OAuth2 Api
 */
class Authenticator {
    constructor(service) {
        const { server: { hostname, endpoint, port, preflight }, username, password, grant_type, client_secret, client_id } = service
        Object.assign(this, { hostname, endpoint, port, preflight, username, password, grant_type, client_secret, client_id })
    }

    get headers() {
        return {
            Authorization: `Bearer ${this.access_token}`,
            'Content-Type': 'application/json',
        }
    }

    queryString(params) {
        return Object.keys(params).map(function(key) {
            return `${key}=${params[key]}`
        }).join('&')
    }

    postData() {
        const { username, password, grant_type, client_secret, client_id } = this
        return querystring.stringify({ username, password, grant_type, client_secret, client_id })
    }

    __logResponse(options, response) {
        const now = (new Date()).toISOString()

        const url = `https://${options.hostname}${options.path}`

        if(response.isError()) {
            Logger.error(
                Lang.logTrans(`Response: ${response.status()} ERROR | ${url}`, {log_type: `HTTPS`})
            )
            Logger.error('\n----- Error Response Body -------\n', response.body, '\n----- End Error Response Body ---\n')
        }
        else if (response.isRedirect()) {
            Logger.error(
                Lang.logTrans(`Response: ${response.status()} REDIRECT | ${url}`, {log_type: `HTTPS`})
            )
        }
        else {
            Logger.log(
                Lang.logTrans(`Response: ${response.status()} OK | ${url}`, {log_type: `HTTPS`} )
            )
        }
    }

    errorResponse(message, error) {
        const status = _.get(error, 'statusCode', 500)
        throw new Response(JSON.stringify({ message, error }, status, {}))
    }

    async makeRequest(options, payload = '') {
        return new Promise((resolve, reject)=>{
            const req = https.request(options, (res) => {

                var body = "";
                res.on("data", data => {
                    body += data;
                });
                res.on("end", () => {
                    const response = new Response(body, res.statusCode, res.headers)
                    this.__logResponse(options, response)

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(response);
                    } else {
                        console.error(response)
                        reject(response);
                    }
                });
            });

            Logger.debug('Request has been made for ' + JSON.stringify({ options }));
            req.on('error', (e) => {
                reject(e);
            });
            req.write(payload);
            req.end();
        })
    }

    async authenticate() {
        const postData = this.postData()
        const { hostname, endpoint } = this

        const options = {
            hostname: hostname,
            path: endpoint,
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': postData.length
            }
        };

        return await this.makeRequest(options, postData).then(async (response) => {
            const data = await response.json();
            this.access_token = data.access_token

            const adapter = { headers: this.headers, }
            Logger.debug("Authenticator Success", adapter)

            return {
                message: "Authenticated",
                response,
                adapter,
            }

        }).catch(error => {
            const message = _.get(error, 'message', "Authentication Error")
            throw this.errorResponse(message, error)
        });
    }
}

/**
 * Response
 *
 * Generic response class that provides a basic interface
 * for some request details
 */
class Response {
    constructor(body, status = 200, headers) {
        this.body = body
        this._status = status
        this._headers = headers
    }

    async json() {
        return new Promise((resolve, reject) => {
            try {
                resolve(JSON.parse(this.body))
            } catch (error) {
                if (this.isXml()) {
                    Logger.dev("REQUEST FOR JSON FALLING BACK TO XML AS PER THE HEADERS")
                    return this.xml().then(resolve).catch(reject)
                }
                throw error
            }
        });
    }

    async xml() {
        return new Promise((resolve, reject) => {

            return resolve({ __xml2js__not_enabled: true });

            parseString(this.body, (error, result) => {
                if (error) reject(error)
                else resolve(JSON.parse(JSON.stringify(result)))
            })
        })
    }

    isXml() {
        return this.contentType().includes('xml')
    }

    isJson() {
        return this.contentType().includes('json')
    }

    contentType() {
        return this.header('content-type')
    }

    headers() {
        return this._headers
    }

    header(key) {
        return _.get(this._headers, key)
    }

    status() {
        return this._status
    }

    isSuccess() {
        return this._status >= 200 && this._status < 300
    }

    isError() {
        return this._status >= 400
    }

    isRedirect() {
        return this._status >= 300 && this._status <= 308
    }

    redirectTo() {
        if (this.isRedirect()) {
            const key = "Location"
            const location = _.get(this._headers, key, _.get(this._headers, key.toLowerCase()), false)
            if (!location) {
                throw { message: "Location not defined in redirect", response: this }
            }
            return location
        }
        return false
    }
}

/**
 * Exports
 */
module.exports = {
    run,
    PlutoraClient,
    customerClient,
    Integration,
    ConfigApi,
    Logger,
};
