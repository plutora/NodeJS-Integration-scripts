/**
 * Plutora Release -> Jira Version Api Integration
 *
 * Script By: Eldon Ahrold (eldon.ahrold@plutora.com)
 * Last Updated: 2019-01-23
 *
 * Notes:
 *   - Script REQUIRES the following parameters
 *      "mail_to" : String (e.g "admin@pretend.com")
 *
 *      "plutora_host": String (e.g. "auapi.plutora.com"),
 *      "plutora_auth_host" : String (e.g "auoauth.plutora.com"),
 *      "plutora_username": String,
 *      "plutora_password": String (Masked),
 *      "plutora_client_id": String,
 *      "plutora_client_secret": String,
 *      "plutora_direct_link_host": String (e.g. "pretend.plutora.com"),
 *
 *      "jira_host": String,
 *      "jira_username": String,
 *      "jira_password": String (Masked),
 *
 */

/**
 * Dev NOTES
 * 2019-01-18 : Using API, cannot Attach Linked Items to Changes at this time.  (Cannot Fulfill Rule 5: Create linkages between Changes)
 *
 * 2019-01-23 : Using API, cannot Create Release Events (CR4556)
 * 2019-01-23 : Using API, cannot Create Audit (User Story 1 Acceptance Criteria 5)
 */

const _ = require('lodash');
const https = require('https');
const querystring = require('querystring');

const isDev = false;
const isDebug = true;

//----------------------------------------------------------
// Constants
//-------------------------------------------------------
const __TESTING_DATE_FROM__ = '2018-10'

/**
 * What time it is now.
 * @type {Date}
 */
const NOW = new Date()

/**
 * Subject Line For the
 * @type {String}
 */
const EMAIL_SUBJECT_LINE  = "Jira to Plutora Integration Report"

/**
 * Default/Fallback System Name Used when matching release and change systems
 * @type {String}
 */
const DEFAULT_SYSTEM_NAME = 'Plutora default'

/**
 * Default Value For Mapping Version -> Release's StatusType
 * @type {String}
 */
const DEFAULT_RELEASE_STATUS_TYPE = 'Screening'

const DEFAULT_CHANGE_DELIVERY_RISK_KEY = "TBD"
const DEFAULT_CHANGE_THEME_KEY = "TBD"

const FALLBACK_CHANGE_TYPE_KEY = "TBD"
const FALLBACK_CHANGE_STATUS_KEY = "TBD"
const FALLBACK_CHANGE_PRIORITY_KEY = "TBD"

/**
 * This is the mapping to convert a Plutora release status string
 * to the respective props for a JIRA version
 * @type {Object}
 */
const STATUS_RELEASE_UNRELEASED = 'Unreleased'
const STATUS_RELEASE_CANCELLED = 'Cancelled'
const STATUS_RELEASE_COMPLETE = 'Completed'

/**
 * Should All HTTP Requests be logged?
 * This can make the logs extremely verbose, and
 * not necessarily provide much useful information
 * It's mostly useful in dev and debug modes
 **/
const LOG_ALL_HTTP_REQUESTS = true;

// The Plutora API can handle 6/second
const API_THROTTLE_SPEED = 1000/6

//-----------------------    ms     s    m    h    d   m
const INITIAL_RUN_INTERVAL = 1000 * 60 * 60 * 24 * 7 * 4 // We'll grab everything four months back if no initial run interval is set

/**
 * Plutora Additional Information Field Keys
 * @type {Object}
 */
const AIFIELDS = {
    JIRA_Project: 'JIRA PROJECT KEY',
    JIRA_ID: "JIRA ID",
    JIRA_KEY: "JIRA KEY",
    RELEASE_IMPLEMENTATION_TIME : "IMPLEMENTATION TIME"
}

/**
 * Message translations used by the Lang utility
 * strings marked with `:someKey` will be substituted out
 * by objects passed in as the second parameter to the Lang.trans("SOME_STRING_KEY", object)
 *
 * @type {Object}
 */
const EN_MESSAGES = {
    WELCOME: "Initializing Plutora Release to JIRA Version Fix API integration",
    MORE_THAN_ONE_FAILURE_DETECTED: "More than one failure was detected during the process. While some updates may have succeeded,\nthe run as a whole will be marked as failed, and all items will be retried on subsequent attempts.",
    UPSERTING_PLUTORA_RELEASE: ":state Plutora RELEASE named ':name'",
    UPSERTING_PLUTORA_RELEASE_SUCCESS: "Successfully :state Plutora RELEASE ':name'",
    UPSERTING_PLUTORA_RELEASE_FAILED: "FAILED :state Plutora RELEASE :name -- :message",

    UPSERTING_PLUTORA_CHANGE: ":state Plutora CHANGE named ':name'",
    UPSERTING_PLUTORA_CHANGE_SUCCESS: "Successfully :state Plutora CHANGE ':name'",
    UPSERTING_PLUTORA_CHANGE_FAILED: "FAILED :state Plutora CHANGE :name -- :message",

    SYSTEM_ASSOCIATION_FAILED: "Failed Associating System ':system' to ':name'",
    SYSTEM_ASSOCIATING : "Associating System ':system' to ':name'",

    CHANGE_SYSTEM_NOT_SET: "CHANGE'S SYSTEM not set",

    RELEASES_TO_ADD: "Found :count new RELEASES adding them to Plutora",
    RELEASES_TO_UPDATE: "Found :count RELEASES to consider for update in Plutora",

    NO_MATCHING_DELIVERY_RELEASE: "Did not find a matching Plutora DELIVERY RELEASE for the RTC STORY",
    NO_CHANGES_DETECTED: "No modifications detected to :type ':name', skipping...",

    ERROR_ATTACHING_ADDITIONAL_INFO: "Error Attaching Additional Info to :type ':name'"
}

/**
 * KEY Used to indicate the existing release id
 * when syncing a version
 * @type {String}
 */
const PLUTORA_RELEASE_SYNC_KEY  = '__plutora_release_sync_id'
const PLUTORA_CHANGE_SYNC_KEY  = '__plutora_change_sync_id'

/**
 * Data map used to convert a Plutora Release Status to the
 * representative keys of a JIRA Version
 * @type {Object}
 */
const RELEASE_TO_VERSION_STATUS_OBJECT_MAP = {
    [STATUS_RELEASE_UNRELEASED]: { archived: false, released: false },
    [STATUS_RELEASE_CANCELLED]: { archived: true, released: false },
    [STATUS_RELEASE_COMPLETE]: { archived: false, released: true },
}

/**
 * The Regex used to match the Project Keys Hot-Fix, HotFix, Hotfix, or hotfix
 * @type {RegExp}
 */
const HOT_FIX_REGEX = /Hot([-]?)Fix/i

/**
 * The Normalized Values For ProjectKey name Matching
 */
const NAME_MATCH_HOTFIX = 'HotFix'
const NAME_MATCH_STANDARD = 'Standard'
const NAME_MATCH_PROJECT = 'Project'
const NAME_MATCH_NORMAL = 'Normal'

const TEMPLATE_TYPES = [
    NAME_MATCH_HOTFIX,
    NAME_MATCH_NORMAL,
    NAME_MATCH_PROJECT,
    NAME_MATCH_STANDARD,
]

/********************************************************************
 ******* Run Plutora Change -> JIRA Issue Api Integration  ***********
 ********************************************************************/
const run = async function(args) {
    return new Promise(async (resolve, reject) => {

        const lastSuccessfulRun = function(args) {
            const __lrs = _.get(args, 'lastSuccessfulRunDateUtc') || Date.now() - INITIAL_RUN_INTERVAL
            return new Date(__lrs)
        }(args)

        const config = ConfigApi(args.arguments)
        const { plutora, jira } = config

        const Plutora = new PlutoraClient(
            plutora.server,
            plutora.auth
        )

        try {
            await Plutora.authenticate()
            Logger.debug("AUTH_SUCCESS", { ...plutora.server, ...plutora.auth })
        } catch (error) {
            Logger.debug("AUTH_FAILED", { ...plutora.server, ...plutora.auth }, true)
            return reject(-1)
        }

        const JIRA = new JIRAClient(
            jira.server,
            jira.auth
        )
        try {
            await JIRA.authenticate()
            Logger.debug("AUTH_SUCCESS", { ...jira.server, ...jira.auth })
        } catch (error) {
            Logger.debug("AUTH_FAILED", { ...jira.server, ...jira.auth }, true)
            return reject(-1)
        }

        const synchronizer = new Synchronizer({ Plutora, JIRA, config })

        try {

            const { analysis } = await synchronizer.runAllJobs({lastSuccessfulRun})

            console.log("Complete",  analysis)

            if ( analysis.failureCount > 0 ) reject(-1)

        } catch (error) {
            Logger.error(error)
            return reject(-1)
        }

        //----------------------------------------------------------
        // Handle Projects
        //-------------------------------------------------------
        resolve(0)
    });
};

/********************************************************************
 ********************* Primary Integration Code *********************
 ********************************************************************/

// Dummy Mailer For Testing
const DummyMailer = {
    send: function(payload) {
        return new Promise((resolve, reject)=>{
            console.log("\n---------------- Pretending to sending mail ----------------\n")
            const { to, subject, cc, body } = payload
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

class StatusCheck {

    constructor(passes, reason) {
        if(!_.isBoolean(passes)) throw "First Parameter of StatusCheck must be a bool"
        if(!_.isString(reason)) throw "Second Parameter of StatusCheck must be a reason string"

        this.passes = passes
        this.reason = reason
    }

    get fails() {
        return !this.passes
    }
}

class SynchronizerRunResults {
    constructor(data = {total:0, total_ignored:0}) {

        console.log("CONSTRUCTOR data", data)

        const { total, total_ignored } = data

        this.updated = {}
        this.created = {}
        this.deleted = {}
        this.ignored = []

        this.total = Number(total)
        this.total_ignored = Number(total_ignored)
    }

    totalConsidered() {
        return this.total + this.total_ignored
    }

}

/**
 * Config API,
 * Used for cleaning up parameters passed in to the script
 *
 * @param {Object} the args variables from run process.
 */
const ConfigApi = function(args) {
    return {
        isDev: args.__IS_DEV__ === 'true',
        mail_to: args.mail_to,

        plutora: {
            direct_link_host: args.plutora_direct_link_host,
            server: {
                hostname: args.plutora_host,
                port: 443,
            },
            auth: {
                server: {
                    hostname: args.plutora_auth_host,
                    endpoint: '/oauth/token'
                },
                client_id: args.plutora_client_id,
                client_secret: args.plutora_client_secret,
                username: args.plutora_username,
                password: args.plutora_password,
                grant_type: 'password',
            },
        },

        jira: {
            server: {
                hostname: args.jira_host,
                port: 443,
            },

            auth: {
                server: {
                    hostname: args.jira_host,
                    endpoint: '/rest/api/2/mypermissions'
                },
                username: args.jira_username,
                password: args.jira_password,
            },
        },
    }
};



/**
 * Perform Data Collection, Mappings, and Upserting
 * for an Integration
 */
class Synchronizer {

    /**
     * @param  {PlutoraClient} options.Plutora Authenticated PlutoraClient
     * @param  {JiraClient} options.JIRA    Authenticated JiraClient
     * @param  {ConfigApi} options.config  ConfigApi instance
     */
    constructor({ Plutora, JIRA, config }) {
        this.Plutora = Plutora
        this.JIRA = JIRA
        this.config = config
        this.__reports = {}

        this.__log = { log: [], 'error': [], 'info': []}
        this.logger = {
            log: (message)=>{
                this.__log.log.push(message)
                Logger.log(Lang.logTrans(message, {log_type: "LOG  "}))
            },

            error: (message, ERROR)=>{
                this.__log.error.push(message)
                Logger.error(Lang.logTrans(message, {log_type: "ERROR"}))
                if (ERROR) Logger.debug({ERROR})
            },

            warn: (message, ERROR)=>{
                Logger.log(Lang.logTrans(message, {log_type: "WARN"}))
                if (ERROR) Logger.debug({ERROR})
            },

            dev: (message, DEV)=>{
                Logger.dev(Lang.logTrans(message, {log_type: "DEV"}))
                if (DEV) Logger.dev({DEV})
            },

            debug: (message, DEBUG)=>{
                Logger.debug(Lang.logTrans(message, {log_type: "DEBUG"}))
                if (DEBUG) Logger.debug({DEBUG})
            },

            info: (message, INFO)=>{
                this.__log.info.push(message)
                // Logger.log(Lang.logTrans(message, {log_type: "INFO "}))
                // if (INFO) Logger.info({INFO})
            },
        }

        this.nodes = {
            jira: {},
            plutora: {},
        }
    }

    async init() {
        this.logger.log(Lang.trans("WELCOME"))
        await this.loadNodes();
    }

    async runAllJobs({lastSuccessfulRun}) {
        const resultsCollection = { analysis: {}, releases: {}, changes: {} }
        const nodes = await this.getNodes()

        try {
            this.logger.log("------- Starting Release Sync Job -------")
            resultsCollection.releases = await this.runVersionsToReleasesSyncJob({lastSuccessfulRun})

            this.logger.log("------- Starting Change Sync Job -------")
            resultsCollection.changes = await this.runIssuesToChangesSyncJob({lastSuccessfulRun})

            const { reportLines, analysis } = this.logReport();

            resultsCollection.analysis = analysis

            const subject_suffix = (analysis.failureCount > 0)  ? " [ With Failures ] " : ""

            await IntegrationMailer.send({
                to: this.config.mail_to,
                subject: `${EMAIL_SUBJECT_LINE} ${subject_suffix}`,
                body: reportLines.join('\n'),
            })


        } catch (error) {
            Logger.error("Uhandled Error Running Synchronizer", `${error}`)
        }

        return resultsCollection
    }

    //----------------------------------------------------------
    // Runners
    //-------------------------------------------------------
    async runVersionsToReleasesSyncJob({ lastSuccessfulRun }) {
        const nodes = await this.getNodes()

        const { changes, hasChanges, total, total_ignored } = await this.getVersionToReleaseConsiderations({ lastSuccessfulRun });

        const results = new SynchronizerRunResults({total, total_ignored}) //{ updated: {}, created: {}, deleted: {}, ignored: [] }

        results.updated = await this.syncExistingJiraVersionsToPlutoraRelease(changes.update)

        const { needs_created } = results.updated

        results.created = await this.syncNewJiraVersionsToPlutoraRelease(changes.create)

        results.ignored = changes.ignore;

        this.setReportData("JIRA VERSIONS -> PLUTORA RELEASES", results)
        return results
    }

    async runIssuesToChangesSyncJob({ lastSuccessfulRun }) {
        const { JIRA } = this
        const nodes = await this.getNodes()

        const issuesSince = await JIRA.issuesSince(lastSuccessfulRun, {page: 0, size: 500})
        const validJiraIssues = await this.preProcessJiraIssues(issuesSince);

        let plutoraChanges = []
        if(validJiraIssues.length > 0) {
            plutoraChanges = await this.getChangeNodes()
        }

        const considerations = await this.processIssueForConsiderations(validJiraIssues, plutoraChanges)
        const { changes, hasChanges, total, total_ignored } = considerations

        const results = new SynchronizerRunResults({total, total_ignored}) //{ updated: {}, created: {}, deleted: {}, ignored: [] }

        results.updated = await this.syncExistingJiraIssuesToPlutoraChanges(changes.update)
        results.created = await this.syncNewJiraIssuesToPlutoraChanges(changes.create)
        results.deleted = await this.deleteInvalidChangesFromPlutroa(changes.delete)

        this.setReportData("JIRA ISSUES -> PLUTORA CHANGES", results)
        return results
    }


    //----------------------------------------------------------
    // Report
    //-------------------------------------------------------

    /**
     * The the contents of the current report,
     * this aggregates for the entire instance's
     * lifecycle.
     *
     * @return {Object} the report
     */
    getReport() {
        return this.__reports
    }

    /**
     * Update the report data
     * @param {String} key  Key for the Report
     * @param {Object} data Report data for given key
     *
     * @return {this}
     */
    setReportData(key, data) {
        this.__reports[key] = data
        return this
    }

    /**
     * Get an analysis of the report that
     * contains usefull information
     *
     * @return {Object} the analysis of the report
     */
    analyzeReport() {
        const report = this.getReport()
        var failureCount = 0;
        var successCount = 0;
        var ignoredCount = 0;
        var deletedCount = 0

        _.forOwn(report, (value, key, idx) => {
            const { created, updated } = value
            failureCount += (created.failed.length + updated.failed.length)
            successCount += (created.success.length + updated.success.length)

            ignoredCount += _.get(value, 'ignored.length', 0)
            deletedCount += _.get(value, 'deleted.length', 0)
        })
        return { failureCount, successCount, deletedCount, ignoredCount };
    }

    logReport() {
        const { reportLines, analysis } = this.getLogReportLines()

        console.log(`\n${reportLines.join('\n')}`)

        return { reportLines, analysis }
    }
    /**
     * Log The current report to console
     *
     * @return {Object} analyzed report
     */
    getLogReportLines() {
        const { Plutora, JIRA } = this

        const analysis = this.analyzeReport()
        const report = this.getReport()

        const padding = 100;

        const reportLines = [];

        const wasWere = function(count){
            return count == 1 ? "was" : "were"
        }

        // Local Util Functions
        const logLineItems = function(items) {
            _.each(items, (item) => {
                const { payload, reason } = item
                const summary = `Entity Name: ${_.get(payload, 'name', "???")}`

                reportLines.push(`  ${summary}`)
                if (reason) {
                    reportLines.push(`    [ Reason: ${reason} ]`)
                }
            })
            reportLines.push("")
        }

        const logLineErrors = function(errors) {
            _.each(errors, (error) => {
                const message = _.isString(error) ? error : _.get(error, 'message', error)
                reportLines.push(`    - ${error}`)
            })
            reportLines.push("")
        }

        // Report Log
        reportLines.push("")
        reportLines.push(_.pad(`   ${Lang.trans("SYNC_REPORT")}   `, padding, "#"))
        reportLines.push(`Date: ${new Date().toISOString()}`)
        reportLines.push(`Plutora Host: ${Plutora.hostname}`)
        reportLines.push(`JIRA Host: ${JIRA.hostname}`)
        reportLines.push("")


        _.forOwn(report, (synchronizerRunResult, key, idx) => {
            const ucKey = key.toUpperCase()
            reportLines.push(_.pad(`  ${ucKey}  `, padding, '='))
            const { created, updated, ignored, deleted } = synchronizerRunResult

            reportLines.push(_.padEnd("+++ SUMMARY ", padding, "+"))

            const __c_count = synchronizerRunResult.totalConsidered()
            reportLines.push(`A TOTAL OF ${__c_count} ENTITIES ${wasWere(__c_count).toUpperCase()} CONSIDERED FOR PROCESSING`)

            reportLines.push(_.padEnd("---- CREATING ", padding, "-"))
            reportLines.push(`${created.success.length} New ${ucKey} ${wasWere(created.success.length)} created`)
            logLineItems(created.success)

            reportLines.push(`${created.failed.length} ${ucKey} failed creation`)
            logLineItems(created.failed)


            reportLines.push(`${created.errors.length} Unhandled errors ${wasWere(created.errors.length)} encountered during the creation process ${ucKey}`)
            logLineItems(created.errors)

            reportLines.push(_.padEnd("---- UPDATING ", padding, "-"))

            reportLines.push(`${updated.success.length} ${ucKey} ${wasWere(updated.success.length)} updated`)
            logLineItems(updated.success)

            reportLines.push(`${updated.failed.length} ${ucKey} failed to update`)
            logLineItems(updated.failed)

            reportLines.push(`${updated.errors.length} Unhandled errors ${wasWere(updated.errors.length)} encountered during the ${ucKey} update process`)

            if(_.isArray(deleted)) {
                reportLines.push(_.padEnd("---- DELETED ", padding, "-"))

                reportLines.push(`${deleted.success.length} ${ucKey} ${wasWere(deleted.success.length)} deleted`)
                logLineItems(deleted.success)

                reportLines.push(`${deleted.failed.length} ${ucKey} failed to delete`)
                logLineItems(deleted.failed)

                reportLines.push(`${deleted.errors.length} Unhandled errors ${wasWere(deleted.errors.length)} encountered during the ${ucKey} delete process`)
            }

            reportLines.push(_.padEnd("---- IGNORING ", padding, "-"))
            reportLines.push(`Ignored ${ignored.length} ${ucKey}`)
            // _.forEach(ignored, (ignore)=>{
            //     reportLines.push(`Ignoring - ${ignore.description}: [REASON: ${ignore.reason}]`)
            // })
        })


        if (analysis.failureCount > 0) {
            reportLines.push(_.padEnd("----  Summary  ", padding, "-"))

            reportLines.push(
                Lang.trans("MORE_THAN_ONE_FAILURE_DETECTED", { count: analysis.failureCount })
            )
            reportLines.push("")
        }

        reportLines.push(_.pad("  END_SYNC_REPORT  ", padding, "#"))
        reportLines.push("")

        return { analysis, reportLines }

    }

    //----------------------------------------------------------
    // Data Nodes
    //-------------------------------------------------------

    /**
     * Load The Related Data used during sync.
     *
     * @return {Promise} Resolves to related data.
     */
    async getNodes(options={reload:false}) {
        if(this.nodes.__is_loaded__ && options.reload !== true) {
            return this.nodes
        }

        const { Plutora, JIRA, config, nodes } = this

        const systems = await Plutora.systems()
        const defaultSystem = _.find(systems, {name: DEFAULT_SYSTEM_NAME})

        const users = await Plutora.users()

        const username = this.plutora_username = await Plutora.me()

        const user = _.find(_.values(users), (u)=>{
            return u.userName = username
        });

        const raisedBy = `${user.firstName} ${user.lastName}`

        const releases = await this.getReleasesDataNode({})

        const sortedReleases = _(releases).values().orderBy(['lastModifiedDate'], ['desc']).map(r=>{
            return _.omit(r, ['additionalInformation'])
        }).value()

        const { organizations, organization_top } = await this._buildOrganizationNode({sortedReleases})

        const lookupFieldNodes = await Plutora.getLookupFieldNodes([
            'ReleaseType',
            'ReleaseRiskLevel',
            'ReleaseStatusType',
            'SystemRoleDependencyType',
            'ChangeStatus',
            'ChangeType',
            'ChangePriority',
            'ChangeDeliveryRisk',
            'ChangeTheme'
        ])

        return this.setNodes({
            ...this.nodes,
            ...lookupFieldNodes,
            organization_top,
            organizations,
            systems,
            defaultSystem,
            raisedBy,
            users,
            user,
            releases,
            sortedReleases,
            __is_loaded__: true,
        })
    }

    setNodes(nodes) {
        return this.nodes = {...this.nodes, ...nodes }
    }

    async getMinimalOrgData() {
        if (this.nodes.minimalOrgData) {
            return this.nodes.minimalOrgData
        }
        const orgs = await this.Plutora.organizations()
        this.nodes.minimalOrgData = orgs
        return orgs
    }

    async getMinimalReleaseData() {
        if (this.nodes.minimalReleaseData) {
            return this.nodes.minimalReleaseData
        }
        const minimalReleaseData = await this.Plutora.releases()
        this.nodes.minimalReleaseData = minimalReleaseData
        return minimalReleaseData
    }

    async _upsertReleaseIntoDataNodes(release) {
        const existing = _.get(this.nodes.releases, release.identifier, {})
        this.nodes.releases[release.identifier] = {
            ...existing,
            ...release
        }

        await this.getMinimalReleaseData();
        this.nodes.minimalReleaseData[release.identifier] = release

        return this
    }

    async setChangeNodes(changes) {
        this.nodes.__plutora_changes = changes
        return this
    }

    async getChangeNodes() {
        if (this.nodes.__plutora_changes) {
            return this.nodes.__plutora_changes
        }
        const __plutora_changes = await this.Plutora.changes({full: true});
        this.nodes.__plutora_changes = __plutora_changes
        return __plutora_changes
    }

    async getVersionsNodes({lastSuccessfulRun}) {
        if (this.nodes.versions) {
            return this.nodes.versions
        }
        return this.nodes.versions = await this.JIRA.allVersions()
    }

    async setVersionsNodes(versions) {
        if(!_.isEmpty(versions)) {
            this.nodes.versions = versions
        }
        return this
    }

    async setReleasesDataNode(releases) {
        if(!_.isEmpty(releases)) {
            this.nodes.releases = releases
        }
        return this
    }

    async getReleasesDataNode() {
        if(!_.isEmpty(this.nodes.releases)) {
            return this.nodes.releases
        }
        const { Plutora } = this;
        return this.nodes.releases = await Plutora.releases({full: true});
    }

    _upsertChangeIntoDataNodes(change) {
        const existing = _.get(this.nodes.__plutora_changes, change.id, {})
        this.nodes.__plutora_changes[change.id] = {
            ...existing,
            ...change
        }
        return this
    }

    async _buildOrganizationNode({sortedReleases}) {
        const { Plutora } = this;
        // Load the Organizations, and extract a release template
        const organizationTree = await Plutora.organizationsTree()
        const additionalTopLevelTemplateFilter = function(name, orgId){
            // This template cmp only get applied to the top level org.
            if (orgId === organizationTree.id) {
                return name.toLowerCase().includes("template")
            }
            return true;
        }

        const organizations = await Plutora.organizations().then(organizations=>{
            return _.map(organizations, org=>{

                const releaseTemplates = _.transform(TEMPLATE_TYPES, (map, templateType)=>{
                    return map[templateType] = _.find(sortedReleases, (release)=>{
                        const typeKey = this.releaseTypeKeyFor(release.name)

                        const matchIfTopLevel = additionalTopLevelTemplateFilter(release.name, release.organizationId)

                        return (release.organizationId === org.id) && (typeKey === templateType) && matchIfTopLevel
                    })
                }, {}) || false

                return { ...org, releaseTemplates }
            })
        }).then((orgs)=>{
            return this.map(orgs, async (org)=>{
                // return org;

                const releaseTemplates = await this.asyncForOwn(org.releaseTemplates, async (release, key)=>{
                    if( !release ) return release;

                    const criterias = await release.load('criterias')
                    const activities = await release.load('activities')
                    const gates = await release.load('gates')
                    const phases = await release.load('phases')
                    const stakeholders = await release.load('stakeholders')
                    return {
                        ...release,
                        criterias,
                        activities,
                        gates,
                        phases,
                        stakeholders,
                    }
                });

                return {
                    ...org,
                    releaseTemplates,
                }
            })

        })

        const organization_top = await Plutora.organizationsTree().then((org)=>{
            return _.find(organizations, {id: org.id})
        })

        return { organization_top, organizations}
    }

    //----------------------------------------------------------
    // Consideration Assessment
    //-------------------------------------------------------
    async getVersionToReleaseConsiderations({ lastSuccessfulRun }) {
        const { versions, releases } = await this.getVersionDataForConsiderations({ lastSuccessfulRun })
        return this.processVersionsForConsiderations({versions, releases})
    }

    async getVersionDataForConsiderations({ lastSuccessfulRun }) {
        const { Plutora, JIRA } = this
        const versions = await this.getVersionsNodes({lastSuccessfulRun})
        const { releases } = await this.getNodes()

        return { versions, releases }
    }

    processVersionsForConsiderations({versions, releases}) {
        // Sort out what's existing and what's new
        const changes = _.transform(versions, ((map, version, idx) => {
            const found = _.get(releases, version.id)

            let { passes, reason } =  this.isValidFixVersion(version);
            if ( passes !== true) {
                map.ignore.push({description: `Name: ${version.name},  ID :${version.id}`, reason})
            }

            else if (_.isEmpty(found)) {
                map.create.push(version)
            }

            else {
                map.update.push({
                    ...version,
                    [PLUTORA_RELEASE_SYNC_KEY]: found.id
                })
            }

            return map;
        }), {
            update: [],
            create: [],
            ignore: [],
            delete: [],
        })

        const total = changes.update.length + changes.create.length;
        const total_ignored = changes.ignore.length

        const hasChanges = total > 0;
        return { hasChanges, total, total_ignored, changes, };
    }

    async preProcessJiraIssues(response, results=[]) {

        await this.asyncForEach(response.data, async (issue)=>{
            const hasValidProjectKey = await this.hasValidProjectKey(issue);
            if( ! hasValidProjectKey) {
                this.logger.debug(`The Project Key For ${issue.key} does not have a matching Plutora Portfolio Association`)
                return
            }
            results.push({...issue, fields: _.pickBy(issue.fields)})
        })

        if (response.next) {
            return response.next().then(_response=>{
                return this.preProcessJiraIssues(_response, results)
            })
        }

        this.logger.info("Completed Pre-processing of Jira Issues")
        return results
    }

    /**
     * Get Considerations to delete
     * @param  {[type]} jIssues  [description]
     * @param  {[type]} pChanges [description]
     * @return {[type]}          [description]
     */
    async processIssueForConsiderations(jIssues, pChanges) {

        const changes = {
            update: [],
            create: [],
            delete: [],
            ignore: [],
        }

        await this.asyncForEach(jIssues, async (issue, idx) => {
            const found = await this.findExistingChangeForIssue(issue)

            const deleteThisChange = await this.shouldChangeBeDeleted(issue, found);
            if (deleteThisChange) {
                this.logger.log(`Marking issue ${issue.key} for Deletion`);
                return changes.delete.push({
                    ...issue,
                    [PLUTORA_CHANGE_SYNC_KEY]: found.id
                })
            }

            const fixVersion = this.latestFixVersionForIssue(issue)
            const { passes, reason } = this.isValidFixVersion(fixVersion)

            if ( passes !== true ) {
                return changes.ignore.push({
                    reason,
                    description: `[Jira Issue] Key: ${issue.key},  ID :${issue.id}`
                })
            }

            if (_.isEmpty(found)) {
                return changes.create.push(issue)
            }

            changes.update.push({
                ...issue,
                [PLUTORA_CHANGE_SYNC_KEY]: found.id
            })
        })

        const total = changes.update.length + changes.create.length + changes.delete.length;
        const total_ignored = changes.ignore.length
        const hasChanges = total > 0;

        return { hasChanges, total, total_ignored, changes, };
    }

    async syncExistingJiraIssuesToPlutoraChanges(issues) {
        const { Plutora, JIRA } = this
        const results = { errors: [], success: [], failed: [],}

        await this.asyncForEach(issues, async (issue) => {
            const payload = await this.mapJiraIssueToChange(issue)

            const response = await this.updatePlutoraChange(payload)
            .then((response)=>{
                const { change, errors } = response
                results.errors.push(...errors)
                results.success.push({ response: change, payload, })
            })
            .catch((reason)=>{
                results.failed.push({ reason, payload })
            })
        })

        return results
    }

   async syncNewJiraIssuesToPlutoraChanges(issues) {
        const { Plutora, JIRA } = this
        const results = { success: [], failed: [], errors: [] }

        await this.asyncForEach(issues, async (issue) => {
            const payload = await this.mapJiraIssueToChange(issue)

            const response = await this.createPlutoraChange(payload)
            .then((response)=>{
                const { change, errors } = response
                results.errors.push(...errors)
                results.success.push({ response: change, payload, })
            })
            .catch((reason)=>{
                results.failed.push({ reason, payload })
            })
        })

        return results
    }

    async deleteInvalidChangesFromPlutroa(issues) {
        const { Plutora } = this
        const results = { success: [], failed: [], errors: [] }

        await this.asyncForEach(issues, async (payload) => {
            const changeId = payload[PLUTORA_CHANGE_SYNC_KEY]

            return await Plutora.deleteChange(changeId)
            .then(response=>{
                results.success.push({ response, payload, })
            })
            .catch((error)=>{
                console.log(error)
                results.errors.push({action: 'deleting_plutora_chage', error,})
                results.failed.push({ error, payload, })
            })
        }).catch(e=>{
            console.log(e)
        })

        return results
    }
    //----------------------------------------------------------
    // Creating & Updating Changes
    //-------------------------------------------------------
    async createPlutoraChange(payload) {

        /**
         * Workflow:
         *     - Create Plutora Change From Payload
         *     - Attach Additional Information To newly created change
         *     - Attach Delivery Releases to newly created change
         *     - Attach Systems to newly created change
         *     - Attach Systems to newly created change's Delivery Releases
         */
        const { Plutora } = this

        const { systems, linkedChanges } = payload.__pending

        const errors = [];

        // We Extract the version ID out of the payload
        // which has been tucked away using the PLUTORA_CHANGE_SYNC_KEY const
        // defined at the top of this file.
        const syncKey = payload[PLUTORA_CHANGE_SYNC_KEY]

        const change = await Plutora.createChange(payload).then(async (change)=>{
            this.logger.log(
                Lang.trans("UPSERTING_PLUTORA_CHANGE_SUCCESS", {state: "Created", ...change })
            )

            // We need to do this because we dont have the ID's of the
            // AdditionalInfo fileds until the field is created.
            // So we can't initially post that data...
            const info = _.map(change.additionalInformation, (field)=>{
                if(field.name === AIFIELDS.JIRA_KEY){
                    field.text = syncKey
                }
                return field
            })

            change.additionalInformation = await Plutora.updateChangeAdditionalInformation(change.id, info)
            .catch(error=>{
                errors.push({action: 'attach_info_to_change', error, data: info})
                this.logger.error(
                    Lang.trans('Error Attaching Additional Info to :type : ":name"',  { type: "Change", name: change.name }),
                    {error, info},
                )
            })

            // Attach Delivery Releases to Change
            // NOTE: This is a little bit weird, because in the Update/PUT payload
            // you can just include these, but you need to explicitly add them after
            // the initial put.
            const deliveryReleases = await this.map(payload.deliveryReleases, async (release)=>{
                return await Plutora.updateChangeDeliveryRelease(change.id, release).then(response=>{
                    return release
                })
                .catch(error=>{
                    errors.push({action: 'attach_delivery_release_to_change', error, data: release})
                    this.logger.error(
                        Lang.trans('Error Setting DeliveryRelease to :type : ":name"',  { type: "Change", name: change.name }),
                        {error, release},
                    )
                })
            })

            // Get the source of truth list from the server, if the
            // current RTC system exists, we'll return early...
            const { changeSystems, changeSystemErrors } = await this.attachSystemToChange(change, systems)
            errors.push(...changeSystemErrors)

            // Attach System to the Change's Releases
            const { addedReleaseSystems, releaseSystemErrors } = await this.attachSystemsToChangeReleases(systems, deliveryReleases)
            errors.push(...releaseSystemErrors)

            return change
        })

        this._upsertChangeIntoDataNodes(change)
        return { errors, change }
    }

    async updatePlutoraChange(payload) {
        /**
         * Workflow:
         *     - Create Plutora Change From Payload
         *     - Attach Additional Information To updated change
         *     - Attach Systems to updated change
         *     - Attach Systems to updated change's Delivery Releases
         */

        const { Plutora } = this

        const { systems, linkedChanges } = payload.__pending

        const errors = [];
        // if(this._dry_run === true) return;
        const change = await Plutora.updateChange(payload).then(async (change)=>{

            this.logger.log(
                Lang.trans("UPSERTING_PLUTORA_CHANGE_SUCCESS", {state: "Updated", ...change })
            )

            // Get the source of truth list from the server, if the
            // current RTC system exists, we'll return early...
            const {changeSystems, changeSystemErrors} = await this.attachSystemToChange(change, systems)
            errors.push(...changeSystemErrors)

            // Attach System to the Change's Releases
            const { addedReleaseSystems, releaseSystemErrors } = await this.attachSystemsToChangeReleases(changeSystems, change.deliveryReleases)
            errors.push(...releaseSystemErrors)

            return change
        })

        this._upsertChangeIntoDataNodes(change)
        return { errors, change }
    }

    async attachSystemToChange(change, systems) {
        const { Plutora } = this;
        const errors = []
        const currentSystems = await Plutora.changeSystems(change.id)

        const changeSystems = await this.map(systems, async (system)=>{
            if (currentSystems[system.systemId]) {
                this.logger.log(`System "${currentSystems[system.systemId].system}" Already Exists on change "${change.changeId}"`)
                return system
            }
            else {
                this.logger.log(
                    Lang.trans('SYSTEM_ASSOCIATING',  { type: "CHANGE", name: change.name, system: system.systemId }),
                    system
                )

                return await Plutora.associateSystemToChange(change.id, system)
                .catch((error)=>{
                    errors.push({action: 'attach_system_to_change', error, data: system,})
                    this.logger.error(
                        Lang.trans('SYSTEM_ASSOCIATION_FAILED',  { type: "CHANGE", name: change.name, system: system.systemId }),
                        error
                    )
                    return system
                })
            }
        })

        return {changeSystems, changeSystemErrors: errors }
    }

    async attachSystemsToChangeReleases(changeSystems, deliveryReleases) {
        const { Plutora } = this;
        const errors = []

        const addedReleaseSystems = await this.map(deliveryReleases, async (release)=>{
            const existingSystems = await Plutora.releaseSystems(release.releaseId)

            const addSystems = _.filter(changeSystems, (changeSys)=>{
                return !_.find(existingSystems, (existing)=>{
                    return changeSys.systemId === existing.systemId
                })
            })

            this.logger.dev(`Attaching ${addSystems.length} Systems to Change`)

            return await this.asyncForEach(addSystems, async (system)=>{
                return await Plutora.associateSystemToRelease(release.releaseId, system)
                .catch(error=>{
                    errors.push({action: 'attach_system_to_change_release', error, data: system})
                    this.logger.error(
                        Lang.trans('SYSTEM_ASSOCIATION_FAILED',  { type: "CHANGE RELEASE", name: release.releaseId, system: system.systemId }),
                        {error, release},
                    )
                })
            })
        }).then(r=>_.flatMap(r));

        return { addedReleaseSystems, releaseSystemErrors: errors }
    }
    //----------------------------------------------------------
    // Creating & Updating Releases
    //-------------------------------------------------------
    async syncNewJiraVersionsToPlutoraRelease(versions) {
        const { Plutora, JIRA } = this
        const results = { success: [], failed: [], errors: [] }


        await this.asyncForEach(versions, async (version) => {
            const payload = await this.mapJiraVersionToPlutoraRelease(version)

            const response = await this.createPlutoraRelease(payload)
            .then((response)=>{
                const { release, errors } = response
                results.errors.push(...errors)
                results.success.push({ response: release, payload, })
            })
            .catch((reason)=>{
                results.failed.push({ reason, payload })
            })
        })

        return results
    }

    async syncExistingJiraVersionsToPlutoraRelease(versions) {
        const { Plutora } = this
        const results = { success: [], failed: [], needs_created: [], errors: [] }
        await this.asyncForEach(versions, async (version) => {
            const payload = await this.mapJiraVersionToPlutoraRelease(version)
            try {

                const { release, errors } = await this.updatePlutoraRelease(payload)
                results.errors.push(...errors)

                // This isn't used now that the integration is combined
                // but in theory there may be a use case for adding chagnes
                // during the relase create event...
                // const changes = await this.applyVersionIssuesToReleaseChanges(version, release)
                results.success.push({ response: release, payload, })

            } catch (error) {
                const reason = (_.isFunction(error.json)  ? await error.json() : _.get(error, 'body')) || `${error}`
                results.failed.push({ reason, payload, })
            }
        })
        return results
    }

    async createPlutoraRelease(payload) {
        const { Plutora } = this;
        const errors = []

        // We'll use this in case of failure,
        // The release should be deleted if the process wasn't 100% successful
        // Including adding gates, phases, stakeholders, etc...
        // that way we can try to recreate next time around.
        let _added_release_id = null;

        const release = await Plutora.createRelease(payload)
        .then(release=>{
            _added_release_id = release.id

            const event = this.makeReleaseEvent(release)

            return Plutora.addEventToRelease(release.id, event).then(success=>{
                this.logger.info("Successfully Added Created Event to Release")
                return release
            }).catch(error=>{
                this.logger.error("Adding Events To Releases is not currently supported w/ the API")
                Logger.debug(`${JSON.stringify(event)}`)
                return release
            })
        })
        .then(async (release)=>{
            // We need to do this because we dont have the ID's of the
            // AdditionalInfo fileds until the field is created.
            // So we can't initially post that data...
            const info = _.map(release.additionalInformation, (field)=>{
                if(field.name === AIFIELDS.RELEASE_IMPLEMENTATION_TIME){
                    field.time = "00:00:00"
                }
                return field
            })

            release.additionalInformation = await Plutora.updateReleaseAdditionalInformation(release.id, info)
            .catch(error=>{
                errors.push({action: 'attach_info_to_release', error, data: info})
                this.logger.error(
                    Lang.trans('Error Attaching Additional Info to :type : ":name"',  { type: "Release", name: release.name }),
                    {error, info},
                )
            })

            return release
        })
        .then((release)=>{
            return Plutora.addRelationsToRelease(release, 'stakeholders').then((stakeholders)=>{
                return {
                    ...release,
                    stakeholders,
                }
            })
        })
        .then(release=>{
            // Order Matters Here... We need to do phases, then add activites
            // w/ remapping the id from the one provided by the template
            return Plutora.addRelationsToRelease(release, 'phases').then((phases)=>{
                const { activities } = release
                release.activities = _.map(activities, (activity)=>{
                    const match = _.find(phases, {__template_provided_id: activity.assignedWorkItemID})
                    return {
                        ...activity,
                        assignedWorkItemID: match.id
                    }
                })

                return Plutora.addRelationsToRelease(release, 'activities').then((activities)=>{
                    return {
                        ...release,
                        activities,
                        phases,
                    }
                })
            })
         })
        .then(release=>{
            return Plutora.addRelationsToRelease(release, 'gates').then((gates)=>{
                const { criterias } = release
                release.criterias = _.map(criterias, (criteria)=>{
                    const match = _.find(gates, {__template_provided_id: criteria.assignedWorkItemID})
                    return {
                        ...criteria,
                        assignedWorkItemID: match.id
                    }
                })

                 return Plutora.addRelationsToRelease(release, 'criterias').then((criterias)=>{
                    return {
                        ...release,
                        criterias,
                        gates,
                    }
                })
            })
         })
        .catch(async error=>{
            errors.push({action: `failed_creating_${payload.name}`, error})

            if(_added_release_id) {
                try {
                    await Plutora.deleteRelease(_added_release_id)
                } catch (e){ }

            }

            if(_.isFunction(error.json)) {
                throw await error.json()
            }
            throw _.get(error, 'body', error)
        })

        try {
            await this._upsertReleaseIntoDataNodes(release)
        } catch (e) {
            Logger.error("Error _upsertReleaseIntoDataNodes", e)
        }

        return { release, errors }
    }

    async updatePlutoraRelease(payload) {
        const { Plutora } = this

        const errors = []
        const { implementationDateIsDirty } = payload
        const release = await Plutora.updateRelease(payload).then(async (release)=>{
            // Do we need to do more on update

            if(implementationDateIsDirty === true) {
                try {
                    const match = await this.findExistingReleaseEvent(release)
                    const event = this.makeReleaseEvent(release)

                    if (match) {
                        await Plutora.updateReleaseEvent(release.id, event)
                    } else {
                        await Plutora.addEventToRelease(release.id, event)
                    }
                } catch (error) {
                    // Logger.error("Release Event", error)
                    this.logger.error("The Plutora API Does not currently support adding Release Events.")
                }
            }

            return release
        })
        .catch(async error=>{
            if(_.isFunction(error.json)) {
                throw await error.json()
            }
            throw _.get(error, 'body', error)
        })

        await this._upsertReleaseIntoDataNodes(release)
        return { release, errors,}
    }

    async applyVersionIssuesToReleaseChanges(version, release) {
        const { Plutora, JIRA } = this

        // Load Issues for the particular version from JIRA
        const { issues } = await JIRA.versionIssues(version.id)
        const changes = await this.getChangeNodes() // await Plutora.releaseChanges(release.id, {full: true})

        const payloads = await this.map(issues, async (issue)=>{
            const existing = _.find(_.values(changes), (change)=>{
                return _.get(change, ['additionalInformation', AIFIELDS.JIRA_ID]) === issue.id
            })
            return await this.mapJiraIssueToReleaseChange(release, issue, existing)
        })

        return payloads
    }

    //----------------------------------------------------------
    // Issue -> Change Data Mapping
    //-------------------------------------------------------
    async systemsPayloadForIssue(issue) {
        const { systems, defaultSystem } = await this.getNodes()
        const components = _.get(issue, 'components', [])

        const payload = _(components).map((component)=>{
            const name = component.name.toLowerCase()
            return _.find(systems, (system)=>{
                return system.name.toLowerCase() == name;
            })
        }).filter().value()

        const systemRoleDependencyType = this.keyOrFirstWithFallback(
            this.nodes.SystemRoleDependencyType,
            'Code Implementation Dependency',
            (key, using)=>{
                this.logger.warn(`Failed Finding System Role Dependency Type "${key}" using "${using}" as Fallback`)
            }
        )

        if (!payload.length) {
            payload.push(defaultSystem)
        }

        return _.map(payload, (system)=>{
            return {
                "systemId": system.id,
                "systemRoleType": "Impact",
                "systemRoleDependencyTypeId": systemRoleDependencyType.id
            }
        })
    }

    async makeDeliveryReleasesForIssue(issue, existingChange) {
        const releases = await this.getMinimalReleaseData()
        const fixVersion = this.latestFixVersionForIssue(issue)
        const release = releases[fixVersion.id]
        const existingReleases = _.get(existingChange, 'deliveryReleases', []) || []
        if ( !release ) return existingReleases;

        return _.uniqBy([
            ...existingReleases,
            {
                releaseId: release.id,
                "targetRelease": true,
                "actualDeliveryRelease": true,
            }
        ], 'releaseId')
    }

    latestFixVersionForIssue(issue) {
        return _.last(
            _.get(issue, 'fields.fixVersions', [])
        )
    }

    async shouldChangeBeDeleted(issue, existingChange) {

        // Exit out early if there's not an existing Change
        if (!existingChange) return false;

        if( ! await this.hasValidProjectKey(issue)) {
            this.logger.warn(`Invalid Project Key "${issue.fields.project.key}" for issue "${issue.key}"`)
            return true
        }

        const fixVersion = this.latestFixVersionForIssue(issue)
        if (!fixVersion) {
            this.logger.warn(`A change exists in Plutora, but the JIRA fixVersion is no longer specified on this issue "${issue.key}"`)
            return true
        }

        return false
    }

    async findExistingChangeForIssue(issue) {
        const changes = await this.getChangeNodes();
        return _.find(changes, (change)=>{
            const changeId = this.extractAdditionalInfoValueForField(change, AIFIELDS.JIRA_KEY)
            return issue.key === changeId
        })
    }

    async findLinkedChangesForIssue(issue) {
        const issuelinks = _.get(issue, 'fields.issuelinks', []);

        return await this.map(issuelinks, async (linkedIssue)=>{
            const relatedIssue = _.get(linkedIssue, "inwardIssue", _.get(linkedIssue,"outwardIssue"))
            const change = await this.findExistingChangeForIssue(relatedIssue)
            const change_id = _.get(change, 'id', null)
            const change_name = _.get(change, 'name', null)

            const version_id = relatedIssue.id

            if (!version_id) this.logger.warn("Missing Linked Issue Version ID", linkedIssue)

            return {
                version_id,
                change_id,
                change_name,
            }
        })
    }

    async mapJiraIssueToChange(issue) {
        this.logger.log(`----------------------------- Mapping Issue : ${issue.key} --------------------------------`)

        const nodes = await this.getNodes();

        const existingChange = await this.findExistingChangeForIssue(issue) || {}
        const deliveryReleases = await this.makeDeliveryReleasesForIssue(issue, existingChange)

        const linkedChanges = await this.findLinkedChangesForIssue(issue)
        const name = issue.fields.summary

        const href = `https://${this.JIRA.hostname}/browse/${issue.key}`
        const description = `<a href="${href}" target='_blank'>JIRA LINK: ${href}</a><p>${this.parseDescription(_.get(issue, 'fields.description'))}</p>`

        // Iteration -> Release
        const syncKey = issue.key

        // Change Type
        const type = _.get(issue, 'fields.issuetype.name')
        const changeTypeId = this.keyOrFirstWithFallback(this.nodes.ChangeType, type, (key, using)=>{
            if (existingChange.changeTypeId) return {id: existingChange.changeTypeId}
            this.logger.warn(`Failed Finding Change Type "${key}" using "${using}" as Fallback`)
        }, FALLBACK_CHANGE_TYPE_KEY).id

        // Change Status
        const statusKey = _.get(issue, 'fields.status.name')
        const changeStatusId = this.keyOrFirstWithFallback(this.nodes.ChangeStatus, statusKey, (key, using)=>{
            if (existingChange.changeStatusId) return {id: existingChange.changeStatusId}
            this.logger.warn(`Failed Finding Change Status "${key}" using "${using}" as Fallback`)
        }, FALLBACK_CHANGE_STATUS_KEY).id

        // Priority
        const priorityKey = _.get(issue, 'fields.priority.name')
        const changePriorityId = this.keyOrFirstWithFallback(this.nodes.ChangePriority, priorityKey, (key, using)=>{
            if (existingChange.changePriorityId) return {id: existingChange.changePriorityId}
            this.logger.warn(`Failed Finding Change Priority "${key}" using "${using}" as Fallback`)
        }, FALLBACK_CHANGE_PRIORITY_KEY).id

        // Risk
        const changeDeliveryRiskId = this.keyOrFirstWithFallback(this.nodes.ChangeDeliveryRisk, DEFAULT_CHANGE_DELIVERY_RISK_KEY, (key, using)=>{
            if (existingChange.changeDeliveryRiskId) return {id: existingChange.changeDeliveryRiskId}
            this.logger.warn(`Failed Finding Change Delivery Risk"${key}" using "${using}" as Fallback`)
        }).id

        // Theme
        const changeThemeId = this.keyOrFirstWithFallback(this.nodes.ChangeTheme, DEFAULT_CHANGE_THEME_KEY, (key, using)=>{
            if (existingChange.changeThemeId) return {id: existingChange.changeThemeId}
            this.logger.warn(`Failed Finding Change Theme "${key}" using "${using}" as Fallback`)
        }).id

        // System
        // const system = this.systemPayloadForFiledAgainst(story[RtcFields.filedAgainst], (key)=>{
        //     this.logger.warn(`Failed Finding FILED_AGAINST to use as SYSTEM For  "${key}"`)
        // })
        const systems = await this.systemsPayloadForIssue(issue)

        const expectedDeliveryDate = "" //story[RtcFields.due]

        const raisedDate = issue.created
        const lastModifiedDate = issue.updated

        //----------------------------------------------------------
        // Use the existing raisedBy if available
        //-------------------------------------------------------
        const raisedById = existingChange.raisedById || _.get(nodes, ['user', 'id']);

        const organizationId = this.findOrganizationForProject(issue.fields.project).id

        return {
            ...existingChange,
            name,
            description,
            changeTypeId,
            organizationId,
            changeStatusId,
            changePriorityId,
            expectedDeliveryDate,
            changeDeliveryRiskId,
            deliveryReleases,
            changeThemeId,
            raisedById,
            raisedDate,
            additionalInformation: _.get(existingChange, 'additionalInformation', []),
            "stakeholders": [],
            "comments": [],
            "businessValueScore": 0,

            [PLUTORA_CHANGE_SYNC_KEY]: issue.key,
            __pending : {
                systems,
                linkedChanges,
            },
        }
    }


    async mapJiraIssueToReleaseChange(release, aIssue, existingChange={}) {

        const issue = await this.mapJiraIssueToChange(aIssue, existingChange);

        // There's a bit of footwork here to get a value
        // that works on update and create
        // First merge the desired Release in with any existing (or [])
        // Then map over so it's toggled on during update.
        // If it's the desired release (the uniqBy) will
        // use the existing release if found first, so that's
        // what needs updated.
        const releaseId = release.id
        const existingReleases =  _.get(existingChange, 'deliveryReleases', [])
        const deliveryReleases = (releaseId ? _.uniqBy([
            ...existingReleases,
            {
                releaseId,
                "targetRelease": true,
                "actualDeliveryRelease": true
            },
        ], 'releaseId') : existingReleases).map((release)=>{
            if (releaseId !== release.releaseId) return release
            return {
                ...release,
                "targetRelease": true,
                "actualDeliveryRelease": true
            }
        })

        return {
            ...issue,
            deliveryReleases,
        }

    }

    //----------------------------------------------------------
    // Version -> Release Data Mapping
    //-------------------------------------------------------
    /**
     * Is the version fix's Project Project Key valid
     * @param  {String}  projectKey The Version Fix's Project -> key
     * @return {Boolean}            Is this a valid project key
     */
    async hasValidProjectKey(entity) {
        const organizations = await this.getMinimalOrgData();

        const key =_.get(entity, 'fields.project.key', '').toUpperCase()
        return _.isString(key) && key.length > 0 && !!_.find(organizations, (org)=>{
            const orgName = org.name.toUpperCase()
            return _.startsWith(orgName, `${key} -`) ||
                _.startsWith(orgName, `${key}-`)
        })
    }

    /**
     * Is the Fix Version valid
     * @param  {Object}  fixVersion The JIRA Fix Version
     * @return {Boolean}            [description]
     */
    isValidFixVersion(fixVersion) {
        if(!fixVersion) return new StatusCheck(false, "There is not an associated fix version on this entity.")

        const releaseDate = _.get(fixVersion, "releaseDate");
        const hasValidDate = function(checkDate) {
            if(!checkDate) return false

            try {
                const date = new Date(checkDate)
                const checkFormat = date.toISOString()

                if(isDev && __TESTING_DATE_FROM__) {
                    return date.getTime() > (new Date(__TESTING_DATE_FROM__)).getTime()
                }

                return date.getTime() > NOW.getTime()

            } catch(error) {
                this.logger.error("Bad Date Format", error)
                return false
            }
        }(releaseDate);

        if (hasValidDate !== true) {
            const reason = releaseDate ?
                `The Fix Version's Release Date of ${releaseDate} is not valid for consideration` :
                `The Fix Version's Release Date Is not set`
            return new StatusCheck(false, reason)
        }

        const str = JSON.stringify(_.pick(fixVersion, ['name'])).toLowerCase()

        if (!this.releaseTypeKeyFor(str)) {
            return new StatusCheck(false, `Name does not contain ["Hotfix", 'Hot-Fix', 'Project', 'Name']`)
        }

        return new StatusCheck(true, 'Version is valid')

    }

    /**
     * Validate the release object has mandatory fields
     * @param  {Object}  release The Plutora Release Object
     * @param  {Boolean} isNew   is the release a new release
     * @return {Boolean}         Do all mandatory fileds exist?
     */
    async hasMandatoryFields(release, isNew=false) {
        return true
    }

    formatVersionSummary(version) {
        const hostname = this.JIRA.hostname;
        const href = `https://${hostname}/projects/${version.project.key}/versions/${version.id}`
        return `<p>${this.parseDescription(version.description)}</p><a href='${href}' target=_blank>JIRA LINK: ${href}`
    }

    findOrganizationForVersion(version) {
        return this.findOrganizationForProject(version.project)
    }

    findOrganizationForProject(project) {
        const key = project.key.toLowerCase()

        const found = _.find(this.nodes.organizations, (org)=>{
            const name = org.name.toLowerCase()
            return _.startsWith(org.name.toLowerCase(), key)
        })

        if(found) return found;
        return this.nodes.organization_top
    }

    async findExistingReleaseEvent(release) {
        const { Plutora, JIRA } = this
        const events = await Plutora.releaseEvents(release.id)
        return _.find(events, (event)=>{
            return _.startsWith(event.description, `[${release.identifier}]`)
        })
    }

    makeReleaseEvent(release, existingEvent){
        // For every newly created Release Hyatt team would like the integration to
        // autocreate a corresponding event.  The Event will have the same name as the
        // Release but will begin with STG - .  The Go-Live date for this event
        // should default to 1 day prior to the Release Implementation date.
        // If Integration runs and an implementation date is updated the
        // corresponding event date should also be updated to 1 day prior.

        let eventDate = new Date(release.implementationDate);
        eventDate.setDate(eventDate.getDate()-1);

        if (existingEvent) {
            return event =   {
                ...match,
                "eventDate": eventDate.toISOString(),
            }
        } else {
            return {
                "name": `STG - ${release.name}`,
                "description": `[${release.identifier}] ${release.description}`,
                "eventDate": eventDate.toISOString(),
                "releaseID": release.id
            }
        }
    }

    releaseTypeKeyFor(name) {
        const str = name.toLowerCase();

        if(HOT_FIX_REGEX.test(str)) return NAME_MATCH_HOTFIX
        if(str.includes('project')) return NAME_MATCH_PROJECT
        if(str.includes('normal')) return NAME_MATCH_NORMAL
        if(str.includes('standard')) return NAME_MATCH_STANDARD

        return false
    }

    extractAccessoryDataFromVersion(version, existing) {
        const key = this.releaseTypeKeyFor(version.name)
        const accessoryData = {
            [NAME_MATCH_HOTFIX] : {
                ReleaseType: "HotFix",
                RiskLevel: "Medium"
            },
            [NAME_MATCH_PROJECT] : {
                ReleaseType: "Project",
                RiskLevel: "High"
            },
            [NAME_MATCH_NORMAL] : {
                ReleaseType: "Normal",
                RiskLevel: "Medium",
            },
            [NAME_MATCH_STANDARD] : {
                ReleaseType: "Standard",
                RiskLevel: "Low",
            }
        }

        const matched = _.get(accessoryData, key, {})

        const data = {
            releaseTypeId: _.get(this.nodes.ReleaseType, [`${matched.ReleaseType}`, 'id']),
            releaseRiskLevelId: _.get(this.nodes.ReleaseRiskLevel, [`${matched.RiskLevel}`, 'id']),
        }

        if( ! existing) {
            const stid = data.releaseStatusTypeId =  _.get(this.nodes.ReleaseStatusType, [ `${DEFAULT_RELEASE_STATUS_TYPE}`, 'id'])

            if(!stid) {
                this.logger.error(`Missing ReleaseStatusType "${DEFAULT_RELEASE_STATUS_TYPE}" From Plutora Portal... This will fail!`)
            }
        }

        return data
    }

    /**
     * Shift Dates Provided by a template by the appropriate staggered value
     * @param  {String} templateImpDate The Implementation Date Provided by the template
     * @param  {String} relImpDate      The Implementation Date Provide by the release
     * @param  {[Object]} object        The Object to update
     * @param  {Array}  keys            The Keys on the object that need updated
     *
     * @return {Object}                 A new object with updated values on matched keys
     */
    shiftDatesOnObjectsByOffset(templateImpDate, relImpDate, object, keys=[]) {
        // return object;

        const templateImplementationDate = new Date(templateImpDate)
        const releaseImplementationDate = new Date(relImpDate)

        const daysBetweenTempImpAndRelImp = (releaseImplementationDate.getTime() - templateImplementationDate.getTime()) / (1000*60*60*24)

        const results = _.transform(keys, (map, value, idx)=>{

            const objKeyValue = _.get(object, value)
            if(_.isEmpty(objKeyValue)) return map

            const templateEntityDate = new Date(objKeyValue)
            const diff = templateEntityDate.getTime() - templateImplementationDate.getTime()

            var finalTime = releaseImplementationDate.getTime() + diff
            var finalDate =  new Date(finalTime)
            map[value] = finalDate.toISOString();

            const daysBetween = diff / (1000*60*60*24)

            this.logger.debug(`There are ${daysBetweenTempImpAndRelImp} days between the template implementationDate and the new implementationDate`)
            this.logger.debug(`Template Implementation Date: ${templateImplementationDate.toLocaleString()}`)
            this.logger.debug(`Template Entity Date: ${templateEntityDate.toLocaleString()}`)

            this.logger.debug(`There should be ${_.round(daysBetween, 2)} days between the implementationDate and the entity date`)

            this.logger.debug(`Release Implementation Date: ${releaseImplementationDate.toLocaleString()}`)
            this.logger.debug(`Final Entity ${value} Date: ${finalDate.toLocaleString()}`)
            this.logger.debug(`-----------------------------------------`)

            return map;
        }, {})

        return {
            ...object,
            ...results
        }
    }

    getTemplateForVersion(version, organization, implementationDate, nodes) {
        const key = this.releaseTypeKeyFor(version.name)

        // Get a clone of the template object, and omit the id key
        // so it's not present on create
        const template = _.omit(_.assign({},
            _.get(organization, ['releaseTemplates', key],
                _.get(nodes, ['organization_top', 'releaseTemplates', key], {})
            )),
        'id')

        this.logger.log(`Using Template ${_.get(template, 'name', "UNKNOWN")}`)

        const gates = _.map(template.gates, (entity)=>{
            return this.shiftDatesOnObjectsByOffset(
                template.implementationDate,
                implementationDate,
                entity,
                ['startDate', 'endDate'],
            )
        })

        const phases = _.map(template.phases, (entity)=>{
            return this.shiftDatesOnObjectsByOffset(
                template.implementationDate,
                implementationDate,
                entity,
                ['startDate', 'endDate'],
            )
        })

        const activities = _.map(template.activities, (entity)=>{
            return this.shiftDatesOnObjectsByOffset(
                template.implementationDate,
                implementationDate,
                entity,
                ['startDate', 'endDate', 'forecastDate'],
            )
        })

        const criterias = _.map(template.criterias, (entity)=>{
            return this.shiftDatesOnObjectsByOffset(
                template.implementationDate,
                implementationDate,
                entity,
                ['startDate', 'endDate', 'forecastDate'],
            )
        })

        return {
            ...template,
            gates,
            phases,
            activities,
            criterias,
        }
    }

    /**
     * Find an existing version for a release
     *
     * Hopefully soon we'll be able to change
     * this and simply do a call to find a match
     * so we don't have to load every release
     * @param  {Object} version the version under consideration
     * @return {Object|null}  A matching Plutora release, if found. null otherwise
     */
    async findExistingReleaseForVersion(version) {
        const releases = await this.getReleasesDataNode()
        return _.get(releases, [version.id], null)
    }

    /**
     * During the Consideration Building Process
     * The Version has an appended PLUTORA_RELEASE_SYNC_KEY value
     * That value is extracted here...
     *
     * @param  {Object} version The Version to be mapped
     * @return {Number}         The Release ID
     */
    async extractExistingReleaseIdFromVersion(version) {
        return _.get(version, PLUTORA_RELEASE_SYNC_KEY)
    }

    async mapJiraVersionToPlutoraRelease(version) {
        this.logger.log(`----------------------------- Mapping Version : ${version.name} --------------------------------`)
        const nodes = await this.getNodes()

        const existing = await this.findExistingReleaseForVersion(version)
        const existingId = await this.extractExistingReleaseIdFromVersion(version)

        const accessory = this.extractAccessoryDataFromVersion(version, existingId)
        const organization = this.findOrganizationForVersion(version)

        const implementationDate = new Date(version.releaseDate).toISOString()
        const implementationDateIsDirty = (implementationDate != _.get(existing, 'implementationDate'))
        if (implementationDateIsDirty) {
            console.log("Dirty Implementation Date", _.get(existing, 'implementationDate'), implementationDate)
        }

        const template = this.getTemplateForVersion(version, organization, implementationDate, nodes)

        const update = function(existing){
            return existing ? { id: existingId } : {}
        }(existingId)

        return {
            ...update,
            ...template,

            // This is used in the update release method to determine
            // whether the related event date should be reset...
            implementationDateIsDirty,
            implementationDate,

            "additionalInformation": [],
            "identifier": version.id,
            "name": version.name,
            "summary": this.formatVersionSummary(version),

            // "location": !!! NOT USED !!!!

            "organizationId": organization.id,
            "organizationName" : organization.name,

            // "parentReleaseId": !!! NOT USED !!!!

            // "displayColor": "#fff", !!! From Template !!!!
            // "plutoraReleaseType": "Independent",  !!! From Template !!!!
            // "releaseProjectType": "IsProject", //"IsProject", !!! From Template !!!!


            // "releaseStatusTypeId": !!! Spread from accessory !!!
            // "releaseRiskLevelId": !!! Spread from accessory !!!
            // "releaseTypeId": !!! Spread from accessory !!!
            ...accessory,
        }
    }

    //----------------------------------------------------------
    // Util
    //-------------------------------------------------------
    parseDescription(description) {
        if(_.isEmpty(description)) return ""
        return description.replace(/\n/g, "<br>")
    }

    extractAdditionalInfoValueForField(entity, fieldName) {
        const field = _.find(entity.additionalInformation, { name: fieldName, })
        if (!_.isObject(field)) return;

        const map = {
            "Number": "number",
            "ListSelect": 'multiListItem',
            "FreeText": "text",
            "Decimal": "decimal",
            "DateTimePicker": "dateTime",
            "DatePicker": "date",
            "TimePicker": "time",
            "ListField": "listItem"
        }

        const key = _.get(map, field.dataType)
        return _.get(field, key)
    }

    keyOrFirstWithFallback(source, key, failedMessage=()=>{}, defaultFallbackKey) {
        const result = _.get(source, key)
        if(result) return result;

        const defaultFound = _.has(source, defaultFallbackKey)
        const using = defaultFound ? defaultFallbackKey : _.keys(source)[0]
        const fallback = source[using]
        const alt = failedMessage(key, using)

        if (!_.isNil(alt)) {
            return alt
        }

        return fallback
    }

    async asyncForEach(array, callback) {
        for (var index = 0; index < array.length; index++) {
            await callback(array[index], index, array)
        }
    }

    async asyncForOwn(object, callback) {
        const result = {}
        for (let prop in object) {
            result[prop] = await callback(object[prop], prop)
        }
        return result
    }

    async map(array, callback) {
        const map = []
        for (var index = 0; index < array.length; index++) {
            const value = await callback(array[index], index)
            map.push(value)
        }
        return map
    }
}

/**
 * Abstract Restable Class
 *
 * Provides a common interface for
 * get, post, put, delete, and some other useful features
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

        this.authenticator = this.makeAuthenticator(auth)
        this.parseUrl = parseUrl
    }

    callRelationLoad(obj, key) {
        if(_.isString(key)) {
            if(_.has(obj, key)) {
                return obj[key]()
            }
            throw `You cannot call ${key} on this object, only available relations are ${_.keys(obj).join(', ')}`
        }
        return obj;
    }

    getHeaders() {
        return this.__adapter.headers;
    }

    makeAuthenticator(auth) {
        return new Authenticator(auth)
    }

    initAdapter(adapter) {
        return new HttpsAdapter({
            hostname: this.hostname,
            path: this.path,
            port: this.port,
            adapter,
        })
    }

    async authenticate() {
        return this.authenticator.authenticate().then(({ message, adapter }) => {
            this.__adapter = this.initAdapter(adapter)
            return this
        });
    }


    async keyJsonArray(json, key) {
        return json.reduce(function(map, obj) {
            map[obj[key]] = obj;
            return map;
        }, {});
    }

    async chunkRequests(array, size=5, delay=100) {
        const chunks = _.chunk(array, size)
        return this.asyncMap(chunks, async (chunk)=>{
            return Promise.all(chunk.map(c=>c()))
        }, delay)
        .then(_.flatMap)
    }

    async wait(ms) {
      return new Promise(resolve => {
        setTimeout(resolve, ms);
      });
    }

    async asyncMap(array, callback, delay=0) {
        const map = []
        for (var index = 0; index < array.length; index++) {
            const value = await callback(array[index], index)
            if(_.isNumber(delay) && delay > 0) {
                await this.wait(delay)
            }
            map.push(value)
        }
        return map
    }

    async asyncFind(array, callback, delay=0) {
        for (var index = 0; index < array.length; index++) {
            const value = await callback(array[index], index)
            if(value) return value;

            if(_.isNumber(delay) && delay > 0) {
                await this.wait(delay)
            }
        }
        return null
    }

    async getJson(endpoint, params) {
        return this.__adapter.get(endpoint, params).then(response=>{
            return response.json()
        })
    }

    async map(array, callback, delay) {
        return await this.asyncMap(array, callback, delay)
    }

    async raw(endpoint, params) {
        return this.__adapter.get(endpoint, params)
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

    async delete(endpoint, params) {
        return this.__adapter.delete(endpoint, params)
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

    _parseRoute(route, opts = {}) {
        Object.keys(opts).forEach(function(key) {
            route = route.replace(`:${key}`, opts[key])
        })
        return route
    }
}

const JiraEndpoints = {
    ISSUE: '/rest/api/2/issue/:issueId',

    FIELDS: '/rest/api/2/field',
    SEARCH: '/rest/api/2/search',

    ISSUES_META: '/rest/api/2/issue/createmeta',
    ISSUE_TRANSITIONS: '/rest/api/2/issue/:issueId/transitions',

    ISSUES: '/rest/api/2/issue',
    ISSUE: '/rest/api/2/issue/:issueId',

    PROJECTS: '/rest/api/2/project',
    PROJECT_VERSIONS: '/rest/api/2/project/:projectId/versions',
    PROJECT: '/rest/api/2/project/:projectId',
    PROJECT_ISSUES: '/rest/api/2/search?jql=project=:projectId',

    STATUSES: '/rest/api/2/status',
    STATUS: '/rest/api/2/status/:statusId',

    USERS: '/rest/api/2/user',

    VERSIONS: '/rest/api/2/version',
    VERSION: '/rest/api/2/version/:versionId',
    VERSION_ISSUES: '/rest/api/2/search?jql=fixVersion=:versionId',
}

const ISSUE_FIELDS = [
    'project',
    'issuetype',
    'issuelinks',
    'fixVersions',
    'created',
    'priority',
    "status",
    "components",
    "description",
    "summary",
]

class JIRAClient extends Restable {
    makeAuthenticator(auth) {
        return new BasicAuthenticator(auth)
    }

    /**
     * Get The Field mapping and their textual representation
     *
     * @return {Object} [description]
     */
    async fields() {
        return this.getJson(JiraEndpoints.FIELDS).then(json => {
            return json.reduce((map, value) => {
                map[value.id] = value.name
                return map
            }, {})
        });
    }

    /**
     * Get the list of Projects in JIRA
     * @return {Array} The Project Data
     */
    async projects() {
        return this.getJson(JiraEndpoints.PROJECTS)
    }

    /**
     * Get a single Project from it's ID
     * @param  {String}  projectId    Project Id or Key
     * @param  {Boolean} options.full Should the related data be eager loaded
     * @return {Object}               Project
     */
    async project(projectId, { full = false }) {
        const endpoint = this._parseRoute(JiraEndpoints.PROJECT, { projectId, })
        return this.getJson(endpoint).then(data => {
            const __load = {
                versions: async()=>{
                    return this.projectVersions(projectId)
                },
                issues: async()=>{
                    return this.projectIssues(projectId)
                }
            }
            if(full !== true) {
                return {
                    ...data,
                    load: (key)=>{
                        return this.callRelationLoad(__load, key);
                    },
                }
            };

            const promises = [
                this.projectIssues(projectId),
            ]
            return Promise.all(promises).then(results => {
                return {
                    ...data,
                    issues: results[0],
                    load: (key)=>{
                        return this.callRelationLoad(__load, key);
                    },
                }
            })
        })
    }

    async projectIssues(projectId) {
        const endpoint = this._parseRoute(JiraEndpoints.PROJECT_ISSUES, { projectId, })
        return this.getJson(endpoint).then(response => {
            return response.issues.map(issue => {
                return {
                    ...issue,
                    fields: _.omitBy(issue.fields, _.isNil)
                }
            })
        });
    }

    async projectVersions(projectId) {
        const endpoint = this._parseRoute(JiraEndpoints.PROJECT_VERSIONS, { projectId, })
        return this.getJson(endpoint)
    }

    async issuesSince(lastModifiedDate, params={}) {
        const {page=0, size=50} = params
        const maxResults = size;
        const startAt = page * size
        // Valid formats include: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd'
        const date = function(rawDate) {
            const date = rawDate ? new Date(rawDate) : new Date()
            const parts = date.toISOString().split('T')
            const calendar = parts[0]
            const time = parts[1].split('.')[0].split(':').slice(0,2).join(":")
            return `${calendar} ${time}`
        }(lastModifiedDate)

        const payload = {
            jql: `updated > "${date}"`,
            startAt,
            maxResults,
            fields: ISSUE_FIELDS,
        }

        return this.post(JiraEndpoints.SEARCH, payload)
        .then(response=>response.json())
        .then(response=>{
            const { maxResults} = response

            const callback=()=>{ return this.issuesSince(lastModifiedDate, {page: page+1, size: maxResults}) }
            return this.__makeIssueResponse(response, {page, size}, callback)
        })
    }

    __makeIssueResponse(response, {page, size}, callback) {
        const { issues, total, startAt, maxResults} = response
        const total_pages = Math.ceil(total/size)
        const remaining_pages = total_pages - (page+1)
        const hasMore = remaining_pages > 0
        const to = startAt + issues.length

        return {
            hasMore,
            total,
            total_pages,
            remaining_pages,
            from: startAt,
            to,
            data: issues,
            next: (hasMore && _.isFunction(callback)) ? callback : false,
        }
    }

    async aggregateIssues(response, prev=[]) {
        const { data, next, total, remaining_pages, hasMore } = response
        const agData = [].concat(prev, data);
        if (next !== false) {
            return await next().then(_response=>{
                return this.aggregateIssues(_response, agData)
            })
        }
        return agData
    }

    async allVersions() {
        return this.projects().then(projects=>{
            return Promise.all(_.map(projects, (project)=>{
                return this.projectVersions(project.id).then(versions=>{
                    return _.map(versions, (version)=>{
                        return {
                            ...version,
                            project: project,
                        }
                    })
                })
            })).then(results=>{
                return [].concat.apply([], results)
            })
        })
    }

    async getVersion(versionId) {
        const endpoint = this._parseRoute(JiraEndpoints.VERSION, { versionId, })
        return this.getJson(endpoint)
    }

    async createVersion(payload) {
        return this.post(JiraEndpoints.VERSIONS, payload).then(response => {
            return response.json()
        })
    }

    async updateVersion(versionId, payload) {
        const endpoint = this._parseRoute(JiraEndpoints.VERSION, { versionId, })
        return this.put(endpoint, payload).then(response => {
            return this.getJson(endpoint)
        })
    }

    async versionIssues(versionId) {
        const endpoint = this._parseRoute(JiraEndpoints.VERSION_ISSUES, { versionId, })
        return this.getJson(endpoint)
    }

    async statuses() {
        return this.getJson(JiraEndpoints.STATUSES)
    }

    async users() {
        const endpoint = `${JiraEndpoints.USERS}/search?username=.&startAt=0&maxResults=2000`
        return this.getJson(endpoint)
    }

    async findUser(userName) {
        if (!userName) return null;
        const endpoint = `${JiraEndpoints.USERS}/search?username=${userName}`
        return this.get(endpoint).then(response => {
            return response.json().then(json => { return _.first(json) });
        })
    }
}

/**
 * Plutora Endpoints
 * @type {Object}
 */
const PlutoraEndpoints = {
    CHANGES: '/changes',
    CHANGE: '/changes/:changeId',
    CHANGE_SYSTEMS: '/changes/:changeId/systems',
    CHANGE_INFORMATION: '/changes/:changeId/additionalInformation',
    CHANGE_DELIVERY_RELEASE: '/changes/:changeId/deliveryReleases/:releaseId',

    LOOKUP_TYPE: '/lookupfields/:type',

    ME: "/me",
    ORGANIZATIONS: "/organizations",

    RELEASES: '/releases',
    RELEASE: "/releases/:releaseId",
    RELEASE_CHANGES: "/releases/:releaseId/changes",
    RELEASE_SYSTEMS: "/releases/:releaseId/systems",
    RELEASE_INFORMATION: '/releases/:releaseId/additionalInformation',

    SYSTEMS: '/systems',
    SYSTEM: "/systems/:systemId",

    TECRs: '/TECRs',
    TECR: "/TECRs/:tecrId",

    USERS: "/users",
}

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
 * Plutora Api Client
 */
class PlutoraClient extends Restable {

    get filters() {
        return PlutoraFilters
    }

    //----------------------------------------------------------
    // Util
    //-------------------------------------------------------
    async mapResponse(response, key) {
        return await response.json().then(json => {
            return this.keyJsonArray(json, key)
        })
    }

    async transform(obj, callback) {
        const transform = {}
        const keys = Object.keys(obj)
        for (var index = 0; index < keys.length; index++) {
            const value = await callback(obj[keys[index]], keys[index], index)
            transform[keys[index]] = value
        }
        return {
            ...transform
        }
    };

    //----------------------------------------------------------
    // User Stuff
    //-------------------------------------------------------
    async me() {
        return this.get(PlutoraEndpoints.ME).then((response) => {
            return response.json()
        });
    };

    async users() {
        const endpoint = PlutoraEndpoints.USERS
        return this.get(endpoint).then(response => {
            return this.mapResponse(response, 'id')
        })
    }

    async organizations() {
        const endpoint = PlutoraEndpoints.ORGANIZATIONS
        return this.get(endpoint).then(response => {
            return this.mapResponse(response, 'id')
        })
    }

    async organizationsTree() {
        const endpoint = `${PlutoraEndpoints.ORGANIZATIONS}/tree`
        return this.get(endpoint).then(response => {
            return response.json()
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

    async latestEntityWhere(endpoint, filters=[]) {
        const filter = this.filters.makeFindingLatest(filters)
        return this.post(`${endpoint}/filter`, filter).then((response) => {
            return response.json().then(async json=>{
                return _.first(json.resultSet)
            })
        });
    }
    //----------------------------------------------------------
    // Lookup Fields
    //-------------------------------------------------------
    /**
     * Get Lookup Fileds For an array types
     * @param  {Array}  types the lookup filed types
     * @return {[Object]} keyed results for looup filed types
     */
    async getLookupFieldNodes(types = []) {
        const promises = types.map((type) => {
            return this.getLookupFields(type)
        })

        return Promise.all(promises).then((all) => {
            return _.transform(types, function(map, key, idx) {
                return map[key] = all[idx]
            }, {})
        })
    }

    /**
     * Get the lookup fields for a given type
     * @param  {String} type the looup field type
     * @return {Object}      the available field values
     */
    async getLookupFields(type) {
        const endpoint = this._parseRoute(PlutoraEndpoints.LOOKUP_TYPE, { type, })
        return this.get(endpoint).then((response) => {
            return this.mapResponse(response, 'value')
        });
    }

    //----------------------------------------------------------
    // Changes
    //-------------------------------------------------------
    async changes(params={ full: false, include: []}) {
        const { full, include } = params;

        return this.get(PlutoraEndpoints.CHANGES).then((response) => {
            if (full !== true) return this.mapResponse(response, 'id')


            // Do a little bit of eager loading to pull out the full data,
            //  we need the AdditionalFields for our comparison....
            return response.json().then(async (json)=>{
                const map = _.map(json, (item)=>{
                    return ()=>{return this.changeById(item.id)}
                })
                const data = await this.chunkRequests(map)
                return this.keyJsonArray(data, 'id');

                // const data = await this.asyncMap(json, async (item)=>{
                //     return await this.changeById(item.id)
                // }, API_THROTTLE_SPEED)
                // return this.keyJsonArray(data, 'id');
            })
        })
    }


    async changesFiltered(filters=[],params={ full: false, include: []}) {
        const { full, include } = params;
        const filter = this.filters.make(filters)

        const endpoint = `${PlutoraEndpoints.CHANGES}/filter`
        return this.post(endpoint, filter).then((response) => {
            return response.json().then(async json=>{

                const resultSet = await this.aggregateFilteredResultsSet(endpoint, filter, json, json.resultSet)
                if (full !== true) return resultSet

                return await this.asyncMap(resultSet, async (item)=>{
                    return await this.changeById(item.id)
                }, API_THROTTLE_SPEED)

            }).then(json=>{
                return this.keyJsonArray(json, "id")
            })
        });
    }

    async changesRaisedBy(user, params={ full: false, include: []}) {
        const { full, include } = params;
        return this.changesFiltered([this.filters.raisedBy(user)], params)
    }

    async changesModifiedSince(date, params={ full: false, include: []}) {
        const { full, include } = params;
        return this.changesFiltered([this.filters.modifiedSince(date)], params)
    }

    /**
     * Get The Change By ID
     * @param  {Number}  changeId     id of the Change
     * @param  {Boolean} options.full Should related info be loaded for the change
     * @return {Object}               Change Data
     */
    async changeById(changeId, config = { full: false }) {
        const { full } = config

        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE, { changeId, })
        return this.get(endpoint).then((response) => {
            return response.json().then(data => {
                if (full !== true) return data;
                const promises = [
                    // this.loadAdditionalInfoFor(endpoint),
                ]
                return Promise.all(promises).then(results => {
                    return {
                        ...data,
                        // additionalInformation: results[0]
                    }
                })
            });
        });
    };

    //Create a new Change in Plutora
    async createChange(change) {
        return this.post(PlutoraEndpoints.CHANGES, change).then((response) => {
            return response.json().then(json=>{
                return json
            })
        });
    };

    //Update an existing Release in Plutora
    async updateChange(change) {
        const changeId = change.id
        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE, { changeId, })

        return this.put(endpoint, change).then((response) => {
            //update release returns no data? :\
            return change // response;
        });
    };

    async updateChangeAdditionalInfo(changeId, additionalInformation = []) {
        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE, { changeId, })
        return this.put(`${endpoint}/additionalInformation`, additionalInformation).then(response => {
            return additionalInformation
        })
    }

    //Create a new Change in Plutora
    async createChange(change) {
        return this.post(PlutoraEndpoints.CHANGES, change).then((response) => {
            return response.json().then(json=>{
                return json
            })
        });
    };

    async deleteChange(changeId) {
        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE, { changeId, })
        return this.delete(endpoint).then((response) => {
            return { 'message': `Successfully Removed Change ${changeId}` }
        });
    };

        // Associate a System to a Release in Plutora
    async changeSystems(changeId) {
        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE_SYSTEMS, { changeId, })
        return this.get(endpoint).then((response) => {
            return this.mapResponse(response, 'systemId')
        });
    };

    // Associate a System to a Release in Plutora
    async updateChangeAdditionalInformation(changeId, additionalInformation) {
        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE_INFORMATION, { changeId, })
        return this.put(endpoint, additionalInformation).then((response) => {
            //update release returns no data? :\
            return additionalInformation
        });
    };

    // Associate a System to a Release in Plutora
    async associateSystemToChange(changeId, system) {
        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE_SYSTEMS, { changeId, })
        return this.post(endpoint, system).then((response) => {
            //update release returns no data? :\
            return system // response;
        });
    };

   // Associate a System to a Release in Plutora
    async updateChangeDeliveryRelease(changeId, release) {
        const releaseId = release.releaseId
        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE_DELIVERY_RELEASE, { changeId, releaseId})
        return this.put(endpoint, release).then((response) => {
            //update release returns no data? :\
            return release // response;
        });
    };

    //----------------------------------------------------------
    // Releases
    //-------------------------------------------------------
    //Get the list of existing Release
    async releases(params={full: false, include: []}) {
        const { full, include } = params;
        return this.get(PlutoraEndpoints.RELEASES).then((response) => {
            return response.json().then(async (json)=>{
                if (full !== true) return json

                const map = _.map(json, (item)=>{
                    return ()=>{ return this.releaseById(item.id, {full, include}) }
                })
                return this.chunkRequests(map)

                // return this.keyJsonArray(data, 'id');
                // return await this.asyncMap(json, async (item)=>{
                //     return await this.releaseById(item.id, {full, include})
                // }, API_THROTTLE_SPEED)
            })
        }).then(data=>{
            return this.keyJsonArray(data, 'identifier');
        });
    };

    async latestReleaseWhere(filters=[], params={full: false, include: []}) {
        const { full, include, aggregate } = params;
        return this.latestEntityWhere(PlutoraEndpoints.RELEASES, filters).then((release)=>{
            return ( release && full ) ? this.releaseById(release.id, {full, include}) : release
        })
    }


    async releasesFiltered(filters=[], params={ aggregate: false, full: false, include: []}) {
        const { full, include, aggregate } = params;
        const filter = this.filters.make(filters)

        const endpoint = `${PlutoraEndpoints.RELEASES}/filter`
        return this.post(endpoint, filter).then((response) => {
            return response.json().then(async json=>{

                const resultSet = await this.aggregateFilteredResultsSet(endpoint, filter, json, json.resultSet)
                if (full !== true) return resultSet

                return await this.asyncMap(resultSet, async (item)=>{
                    return await this.releaseById(item.id, {full, include,})
                }, API_THROTTLE_SPEED)

            }).then(json=>{
                return this.keyJsonArray(json, "id")
            })
        });
    }

    /**
     * Get A List Of Releases RaisedSince a given date
     * @param  {Date}   date   [description]
     * @param  {Object} params [description]
     * @return {Object}        [description]
     */
    async releasesModifiedSince(date, params = { aggregate : false, full : false, include: [] }) {
        return this.releasesFiltered([this.filters.modifiedSince(date)], params)
    }

    async releasesRaisedBy(user, params={ full: false, include: []}) {
        return this.releasesFiltered([this.filters.raisedBy(user)], params)
    }

    async releasesWhereIn___Broken___(property, whereInValues=[], params={aggregate: false, full: false, include: []}) {
        return this.releasesFiltered([
            this.filters.isWithin(property, whereInValues)
        ], params)
    }

    async releasesWhereIn(property, whereInValues=[], params={aggregate: false, full: false, include: []}) {
        const { full, include, aggregate } = params;

        return this.releases().then(async json => {
            const filtered = _.filter(_.values(json), (item)=>{
                const passes = _.includes(whereInValues, _.get(item, property))
                return passes
            })

            if (aggregate !== true) return filtered

            return await this.asyncMap(filtered, async (item)=>{
                return await this.releaseById(item.id, {full, include})
            }, API_THROTTLE_SPEED)

        })
        .then(data=>{
            return this.keyJsonArray(data, 'identifier');
        })
    }

    __loadableReleaseRelations(releaseId) {
        return {
            changes: async ()=>{
                return await this.releaseChanges(releaseId)
            },
            systems: async ()=>{
                return await this.releaseSystems(releaseId)
            },
            stakeholders: async ()=>{
                return await this.releaseStakeholders(releaseId)
            },
            phases: async ()=>{
                return await this.releasePhases(releaseId)
            },
            activities: async ()=>{
                return await this.releaseActivities(releaseId)
            },
            gates: async ()=>{
                return await this.releaseGates(releaseId)
            },
            criterias: async ()=>{
                return await this.releaseCriterias(releaseId)
            }
        }
    }

    deserializeReleases(releases) {
        return _.map(releases, (release)=>{
            const __load = this.__loadableReleaseRelations(release.id)
            return {
                ...release,
                load: (key)=>{
                    return this.callRelationLoad(__load, key);
                }
            }
        })
    }

    //Get the details of an existing Release by GUID
    async releaseById(releaseId, params ={ full: false, include: [] }) {
        const { full, include } = params
        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })
        return this.get(endpoint).then((response) => {
            return response.json().then(data => {
                const __load = this.__loadableReleaseRelations(releaseId)
                if (full !== true) return {
                    ...data,
                    load: (key)=>{
                        return this.callRelationLoad(__load, key);
                    },
                };
                const promises = [
                    // this.releaseSystems(releaseId),
                    // this.releaseStakeholders(releaseId),
                    // this.commentsFor("Release", releaseId) // !<-- Comments Endpoint broken? (Status Code 403 as of 2018-12-10)
                    // this.loadAdditionalInfoFor(endpoint), // !<--  Currently Release Endpoint returns this, so no need to additionally load.
                ]

                return Promise.all(promises).then(results => {
                    return {
                        ...data,
                        load: (key)=>{
                            return this.callRelationLoad(__load, key);
                        },
                        // systems: results[0],
                        // stakeholders: results[1],
                        // additionalInformation: results[2],
                    }
                })
            });
        });
    };

    async releaseStakeholders(releaseId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/stakeholders`
        return this.getJson(endpoint)
    }

    async releaseSystems(releaseId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/systems`
        return this.getJson(endpoint)
    }

    async releaseChanges(releaseId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/changes`
        return this.getJson(endpoint)
    }

    async releasePhases(releaseId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/phases`
        return this.getJson(endpoint)
    }

    async releaseGates(releaseId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/gates`
        return this.getJson(endpoint)
    }

    async releaseActivities(releaseId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/activities`
        return this.getJson(endpoint)
    }

    async releaseCriterias(releaseId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/criterias`
        return this.getJson(endpoint)
    }

    async releaseEvents(releaseId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/events`
        return this.getJson(endpoint)
    }

    //Create a new Release in Plutora
    async createRelease(release) {
        if(release.id) throw `A Release ID was set on ${release.name}, ignoring...`
        return this.post(PlutoraEndpoints.RELEASES, release).then((response) => {
            return response.json()
        }).then(json=>{
            return {
                ...release,
                ...json
            }
        });
    };

    //Update an existing Release in Plutora
    async updateRelease(release, isDirty=true) {
        if (isDirty === false) return release

        const releaseId = release.id
        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })

        return this.put(endpoint, release).then((response) => {
            //update release returns no data? :\
            return release // response;
        }).catch(e=>{ throw e });
    };

    async deleteRelease(releaseId) {
        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })
        return this.delete(endpoint).then((response) => {
            return { 'message' : `successfully removed release ${releaseId}`}
        }).catch(e=>{ throw e });
    };

    // Associate a System to a Release in Plutora
    async updateReleaseAdditionalInformation(releaseId, additionalInformation) {
        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE_INFORMATION, { releaseId, })
        return this.put(endpoint, additionalInformation).then((response) => {
            //update release returns no data? :\
            return additionalInformation
        });
    };


    async addEventToRelease(releaseId, event) {
        const endpoint = `${PlutoraEndpoints.RELEASES}/events`
        const merged = {
            ...event,
            releaseID: releaseId,
        }
        return this.post(endpoint, [ merged ]).then(response=>response.json())
    }

    async updateReleaseEvent(releaseId, event) {
        const endpoint = `${PlutoraEndpoints.RELEASES}/events`
        return this.put(endpoint, [ event ]).then(response=>response.json())
    }

    async addRelationsToRelease(release, relation) {
        const releaseId = release.id;
        const supportedRelations = _.keys(this.__loadableReleaseRelations())
        const relationData = _.get(release, relation, []);

        if(! supportedRelations.includes(relation)) {
            const message = `${relation} is not a supported relation type for project. supported types: [${ supportedRelations.join(', ')}]`
            console.error(message)
            throw message
        }

        const endpoint = `${this._parseRoute(PlutoraEndpoints.RELEASE, { releaseId, })}/${relation}`

        if(_.isArray(relationData)) {
            return this.asyncMap(relationData, (item)=>{
                return this.post(endpoint, item).then(response=>{
                    return response.json().then(json=>{
                        return {
                            ...json,
                            __template_provided_id: item.id
                        }
                    })
                })
            })
        }

        return this.post(endpoint, relationData).then(response=>{
            return response.json().then(json=>{
                return {
                    ...json,
                    __template_provided_id: item.id
                }
            })
        })

    }
    //----------------------------------------------------------
    // Systems
    //-------------------------------------------------------
    async systems() {
        const endpoint = PlutoraEndpoints.SYSTEMS
        return this.get(endpoint).then(response => {
            return response.json()
        })
    }

    async systemById(systemId, {full = false}) {
        const endpoint = this._parseRoute(PlutoraEndpoints.SYSTEM, { systemId, })
        return this.get(endpoint).then(response => {
            return response.json()
        })
    }

    async systemAdditionalInfo(systemId) {
        const endpoint = `${this._parseRoute(PlutoraEndpoints.SYSTEM, { systemId, })}/additionalInformation`
        return this.get(endpoint).then(response => {
            return response.json()
        })
    }

    // Associate a System to a Release in Plutora
    async associateSystemToChange(changeId, system) {
        const endpoint = this._parseRoute(PlutoraEndpoints.CHANGE_SYSTEMS, { changeId, })
        return this.post(endpoint, system).then((response) => {
            //update release returns no data? :\
            return system // response;
        });
    };

    // Associate a System to a Release in Plutora
    async associateSystemToRelease(releaseId, system) {
        const endpoint = this._parseRoute(PlutoraEndpoints.RELEASE_SYSTEMS, { releaseId, })
        return this.post(endpoint, system).then((response) => {
            //update release returns no data? :\
            return system // response;
        });
    };
    //----------------------------------------------------------
    // Additional Info Loader
    //-------------------------------------------------------
    async loadAdditionalInfoFor(endpoint) {
        return this.get(`${endpoint}/additionalInformation`).then(response => {
            return response.json()
        })
    }

    async commentsFor(type, id) {
        const endpoint = this._parseRoute(PlutoraEndpoints.COMMENTS, { type, id, })
        return this.get(endpoint).then(response => {
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
    isHttp: LOG_ALL_HTTP_REQUESTS,

    disableDebug() {
        this.isDebug = false
    },

    enableDebug() {
        this.isDebug = true
    },

    debug() {
        if (this.isDebug) {
            console.log(...arguments)
        }
    },

    dev() {
        if (this.isDev) {
            console.log(...arguments)
        }
    },

    logHttp() {
        if (this.isHttp) console.log(...arguments)
    },

    log() {
        console.log(...arguments)
    },

    info() {
        console.error(...arguments)
    },

    warn() {
        console.error(...arguments)
    },

    error() {
        console.error(...arguments)
    },

    lang(message, subs = {}, error = false) {
        const trans = Lang.trans(message, subs)
        const method = error === true ? "error" : "log"
        this[method](trans)
        return trans
    },
}

/**
 * Parse A URL into an object
 * @param  {string} url The URL String
 * @return {Object}     url object similar to one returned from node's url.parse()
 */
const parseUrl = function(url) {
    var match = url.match(/^(http|https|ftp)?(?:[\:\/]*)([a-z0-9\.-]*)(?:\:([0-9]+))?(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i);
    var ret = new Object();

    ret['protocol'] = '';
    ret['hostname'] = match[2];
    ret['port'] = '';
    ret['pathname'] = '';
    ret['search'] = '?';
    ret['query'] = '';
    ret['fragment'] = '';

    if (match[1]) {
        ret['protocol'] = match[1];
    }

    if (match[3]) {
        ret['port'] = match[3];
    }

    if (match[4]) {
        ret['pathname'] = `${match[4]}`;
    }

    if (match[5]) {
        ret['query'] = match[5];
        ret['search'] = `?${match[5]}`
    }

    if (match[6]) {
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
    constructor({ hostname, adapter, path }) {
        const { headers } = adapter

        this.hostname = hostname
        this.headers = headers
        this.prefix = path

        this._maxRedirects = 3
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

    __reset() { /* Not Currently Used */ }

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

    async __followRedirect(response, config = {}) {
        let __redirectCount = config.__redirectCount || 0

        if (++__redirectCount > this._maxRedirects) {
            throw "Too Many Redirects";
        }

        let location = response.redirectTo()
        Logger.dev("[ DEV ] Redirecting To", { location })

        return this._raw_request_(location, null, { __redirectCount })
    }

    __logResponse(options, response) {
        const now = (new Date()).toISOString()
        const { method, hostname, path } = options

        const url = `https://${hostname}${path}`

        if (response.isError()) {
            Logger.error(
                Lang.logTrans(`Response: ${response.status()} | ${method} | ERROR | ${url}`, { log_type: `HTTPS` })
            )
            Logger.error(
                '\n',
                '-------------------- Begin Error Response Body --------------------\n',
                response.body,
                '\n--------------------- End Error Response Body ---------------------\n'
            )
        } else if (response.isRedirect()) {
            Logger.warn(
                Lang.logTrans(`Response: ${response.status()} | ${method} | REDIRECT | ${path}`, { log_type: `HTTPS` })
            )
        } else {
            Logger.logHttp(
                Lang.logTrans(`Response: ${response.status()} | ${method} | OK | ${url}`, { log_type: `HTTPS` })
            )
        }
    }

    async makeRequest(options, data = {}) {
        const payload = !!Object.keys(data).length ? JSON.stringify(data) : ""

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let body = "";
                res.on("data", data => {
                    body += data;
                });

                res.on("end", () => {
                    const response = new Response(body, res.statusCode, res.headers)
                    this.__logResponse(options, response)

                    if (response.isRedirect()) {
                        var __redirectCount = _.get(options, '__redirectCount', 0)
                        return this.__followRedirect(response, { __redirectCount }).then(redirectResponse => {
                            resolve(redirectResponse)
                        })
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
                const message = `Request Error https://${options.hostname}/${options.path}`;
                var response = new Response(JSON.stringify({ message, error }), 500, {})
                reject(response);
            });

            req.write(payload);
            req.end();
        });
    };

    async __ANY(method, endpoint, params) {
        const options = this.__buildRequestOptions({
            method: method,
            path: this.__prefixedPath(endpoint)
        })
        return this.makeRequest(options, params)
    }

    async get(endpoint, params) {
        const path = this.__pathAppendingQueryString(endpoint, params)
        return this.__ANY("GET", path)
    }

    async post(endpoint, params) {
        return this.__ANY("POST", endpoint, params)
    }

    async put(endpoint, params) {
        return this.__ANY("PUT", endpoint, params)
    }

    async delete(endpoint, params) {
        return this.__ANY("DELETE", endpoint, params)
    }
}

/**
 * Authenticator Class For any Sane OAuth Api
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
        const { method, hostname, path } = options

        const url = `https://${hostname}${path}`

        if (response.isError()) {
            Logger.error(
                Lang.logTrans(`Response: ${response.status()} | ${method} | ERROR | ${url}`, { log_type: `HTTPS` })
            )
            Logger.error(
                '\n',
                '-------------------- Begin Error Response Body --------------------\n',
                response.body,
                '\n--------------------- End Error Response Body ---------------------\n'
            )
        } else if (response.isRedirect()) {
            Logger.error(
                Lang.logTrans(`Response: ${response.status()} | ${method} | REDIRECT | ${path}`, { log_type: `HTTPS` })
            )
        } else {
            Logger.log(
                Lang.logTrans(`Response: ${response.status()} | ${method} | OK | ${url}`, { log_type: `HTTPS` })
            )
        }
    }

    errorResponse(message, error) {
        const status = _.get(error, 'statusCode', 500)
        throw new Response(JSON.stringify({ message, error }, status, {}))
    }

    async makeRequest(options, payload = '') {
        return new Promise((resolve, reject) => {
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

class BasicAuthenticator extends Authenticator {

    async authenticate() {
        const { username, password, hostname, endpoint } = this;
        const encodable = `${username}:${password}`

        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(encodable).toString('base64')}`
        }

        const options = {
            hostname: hostname,
            path: endpoint,
            method: 'GET',
            rejectUnauthorized: false,
            headers,
        };

        return await this.makeRequest(options).then(async (response) => {
            const data = await response.json();
            const adapter = { headers, }
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
                const json = JSON.parse(this.body)
                resolve(json)
            } catch (error) {
                if (this.isXml()) {
                    Logger.dev("REQUEST FOR JSON FALLING BACK TO XML AS PER THE HEADERS")
                    return this.xml().then(resolve).catch(reject)
                }
                throw error
            }
        }).catch(error=>{
            if(this.isError()) {
                return { error, }
            }
            throw error
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
        return this.header('content-type') || ""
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
    JIRAClient,
    PlutoraClient,
    ConfigApi,
    Synchronizer,
    Logger,
};
