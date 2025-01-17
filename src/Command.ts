/**
 * This program has been developed by students from the bachelor Computer Science at Utrecht University within the Software Project course.
 * � Copyright Utrecht University (Department of Information and Computing Sciences)
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Flags } from "./Input";
import HashData from "./modules/searchSECO-parser/src/HashData";
import { AuthorData } from "./modules/searchSECO-spider/src/Spider";
import ModuleFacade from "./ModuleFacade";
import path from 'path'
import Logger, { Verbosity } from "./modules/searchSECO-logger/src/Logger";
import DatabaseRequest from "./DatabaseRequest";
import { ProjectMetadata } from "./modules/searchSECO-crawler/src/Crawler";

/**
 * Makes a designated repo download location for the current miner.
 * @param minerId The ID of the current miner
 * @returns a path string representing the repo download location for the current miner.
 */ 
const DOWNLOAD_LOCATION = (minerId: string) => path.join(__dirname, `../.tmp/${minerId}`)

/**
 * Static class storing SIGINT signals. 
 * This is used to stop the current process when a SIGINT is fired.
 */
export class SigInt {
    public static Stop = false
    public static IsStopped = false
    /**
     * Signals that the process needs to be stopped. 
     * Waits until the process signals that it's actually stopped.
     * @param minerId The miner ID associated with the current process.
     */
    public static async StopProcess(minerId: string) {
        this.Stop = true
        while (!this.IsStopped)
            await new Promise(resolve => (setTimeout(resolve, 1000)))
        if (this.Stop) {
            await DatabaseRequest.SetMinerStatus(minerId, 'idle')
            process.exit(0)
        }
    }
    /**
     * Resumes the process if it was gracefully stopped with the SigInt.StopProcess() function
     */
    public static ResumeProcess() {
        this.Stop = false
    }
    /**
     * Gracefully stops the process immediately.
     * @param minerId The miner ID associated with the current process
     */
    public static async StopProcessImmediately(minerId: string) {
        await DatabaseRequest.SetMinerStatus(minerId, 'idle')
        process.exit(0)
    }
}

/**
 * The base Command class. This class holds most of the functionalities for modifying repositories
 */
export default abstract class Command {
    protected static _helpMessageText: string
    protected _flags: Flags
    protected _minerId: string

    protected _moduleFacade: ModuleFacade

    constructor(minerId: string, flags: Flags) {
        this._flags = flags
        this._minerId = minerId

        this._moduleFacade = new ModuleFacade(DOWNLOAD_LOCATION(this._minerId), Logger.GetVerbosity())
    }

    /**
     * Gets the help message associated with the current command
     * @returns The help message associated with the current command
     */
    public static GetHelpMessage(): string {
        return this._helpMessageText
    }

    /**
     * Executes the command.
     */
    public abstract Execute(verbosity: Verbosity): Promise<void>;

    /**
     * Parses a project and retrieves author data.
     * @returns a tuple containing a HashData array and an AuthorData object
     */
    protected async parseAndBlame() 
        : Promise<[HashData[], AuthorData]>
    {
        const [filenames, hashes] = await this._moduleFacade.ParseRepository(DOWNLOAD_LOCATION(this._minerId))
        const filteredFileNames: string[] = []

        hashes.forEach(hash => {
            const idx = filenames.findIndex(file => file === hash.FileName)
            if (idx < 0)
                return
            filteredFileNames.push(filenames[idx])
            filenames.splice(idx, 1)
        })

        if (hashes.length == 0) {
            Logger.Debug("No methods found, skipping authors", Logger.GetCallerLocation())
            return [hashes, new Map() as AuthorData]
        }

        const authorData = await this._moduleFacade.GetAuthors(DOWNLOAD_LOCATION(this._minerId), filteredFileNames)
        return [hashes, authorData]
    }

    /**
     * Processes a project and uploads it to the database.
     * @param jobID The current job ID
     * @param jobTime The time the job has been uploaded
     * @param startTime The time the job started
     */
    protected async uploadProject(jobID: string, jobTime: string, startTime: number): Promise<void> {
        Logger.Info("Uploading project to database", Logger.GetCallerLocation())

        const metadata = await this._moduleFacade.GetProjectMetadata(this._flags.MandatoryArgument)

        if (!metadata) {
            Logger.Warning("Error getting project metadata. Moving on", Logger.GetCallerLocation())
            return
        }

        // Set default branch
        if (!this._flags.Branch || (["main", "master"].includes(this._flags.Branch) && this._flags.Branch !== metadata.defaultBranch))
            this._flags.Branch = metadata.defaultBranch
        Logger.Debug(`Default branch is ${this._flags.Branch}`, Logger.GetCallerLocation())
        
        const startingTime = await DatabaseRequest.GetProjectVersion(metadata.id.toString(), metadata.versionTime)
        if (parseInt(metadata.versionTime) <= startingTime) {
            Logger.Info("Most recent version already in database", Logger.GetCallerLocation())
            return
        }

        const success = await this._moduleFacade.DownloadRepository(this._flags.MandatoryArgument, this._flags)
        if (!success) 
            return      
        metadata.versionHash = await this._moduleFacade.GetCurrentVersion(DOWNLOAD_LOCATION(this._minerId))

        const vulnCommits = await this._moduleFacade.GetVulnerabilityCommits(DOWNLOAD_LOCATION(this._minerId))
        Logger.Info(`${vulnCommits.length} vulnerabilities found in project`, Logger.GetCallerLocation())

        for (const commit of vulnCommits) {
            Logger.Info(`Uploading vulnerability: ${commit.vulnerability}`, Logger.GetCallerLocation())
            jobTime = await DatabaseRequest.UpdateJob(jobID, jobTime)
            startTime = Date.now()
            await this.uploadPartialProject(commit.commit, commit.lines, commit.vulnerability, metadata)
        }

        if (metadata.defaultBranch !== this._flags.Branch)
            await this._moduleFacade.SwitchVersion(DOWNLOAD_LOCATION(this._minerId), this._flags.Branch)
        const tags = await this._moduleFacade.GetRepositoryTags(DOWNLOAD_LOCATION(this._minerId))
        const tagc = tags.length

        if (parseInt(metadata.versionTime) > startingTime && tagc == 0) {
            await this.parseLatest(metadata)
        }
        else if (tagc != 0) {
            if (tags[tagc-1][1] <= startingTime) {
                Logger.Info("Latest tag of project already in database", Logger.GetCallerLocation())
                return
            }
            await this.loopThroughTags(tags, metadata, startingTime, jobID, jobTime, startTime)
        }
    }

    protected async uploadPartialProject(version: string, lines: Map<string, number[]>, vulnCode: string, metadata: ProjectMetadata) {
        if (!metadata.id) {
            const newMetadata = await this._moduleFacade.GetProjectMetadata(this._flags.MandatoryArgument)
            if (!this._flags.Branch)
                this._flags.Branch = newMetadata.defaultBranch
        }

        await this._moduleFacade.SwitchVersion(DOWNLOAD_LOCATION(this._minerId), version),
        await this._moduleFacade.TrimFiles(lines, DOWNLOAD_LOCATION(this._minerId))

        const [filenames, hashes] = await this._moduleFacade.ParseRepository(DOWNLOAD_LOCATION(this._minerId))
        const trimmedHashes = this.trimHashes(hashes, lines)
        if (trimmedHashes.length == 0) {
            Logger.Debug("No methods present after trim, skipping authors", Logger.GetCallerLocation())
            return
        }
        trimmedHashes.forEach(hash => {
            hash.VulnCode = vulnCode
        })
        const filteredFileNames: string[] = []
        trimmedHashes.forEach(hash => {
            filteredFileNames.push(filenames[filenames.findIndex(file => {
                file.includes(hash.FileName)
            })])
        })
        const authorData = await this._moduleFacade.GetAuthors(DOWNLOAD_LOCATION(this._minerId), filteredFileNames)
        metadata.versionTime = await this._moduleFacade.GetVersionTime(DOWNLOAD_LOCATION(this._minerId), version)
        metadata.versionHash = version
        await DatabaseRequest.UploadHashes(trimmedHashes, metadata, authorData, "", [])
    }

    private async parseLatest(metadata: ProjectMetadata) {
        Logger.Debug("No tags found, just looking at HEAD", Logger.GetCallerLocation())
        const [hashes, authorData] = await this.parseAndBlame()
        if (hashes.length == 0)
            return
        Logger.Debug("Uploading hashes", Logger.GetCallerLocation())
        await DatabaseRequest.UploadHashes(hashes, metadata, authorData, "", [])
    }

    private async loopThroughTags(tags: [string, number, string][], metadata: ProjectMetadata, startingTime: number, jobID: string, jobTime: string, _startTime: number) {
        let i = 0
        while (tags[i][1] <= startingTime)
            i++
        
        let prevTag = ""
        let prevVersionTime = ""
        const prevUnchangedFiles: string[] = []

        if (i > 0) {
            prevTag = tags[i-1][0]
            prevVersionTime = tags[i-1][1].toString()
        }

        let jobUpdated = false
        for (; i < tags.length; i++) {
            const currTag = tags[i][0]
            const versionTime = tags[i][1]
            const versionHash = tags[i][2]

            metadata.versionTime = versionTime.toString()
            metadata.versionHash = versionHash

            Logger.Info(`Processing tag: ${currTag} (${i+1}/${tags.length})`, Logger.GetCallerLocation())
            Logger.Debug(`Comparing tags: ${prevTag} and ${currTag}.`, Logger.GetCallerLocation())

            if (!jobUpdated) {
                await DatabaseRequest.UpdateJob(jobID, jobTime)
                jobUpdated = true
            }

            /* eslint-disable @typescript-eslint/no-unused-vars */
            _startTime = Date.now()
            const success = await this.downloadTagged(prevTag, currTag, metadata, prevVersionTime, prevUnchangedFiles)
            if (!success)
                break;

            prevTag = currTag
            prevVersionTime = versionTime.toString()
        }
    }

    private async downloadTagged(prevTag: string, currTag: string, metadata: ProjectMetadata, prevVersionTime: string, prevUnchangedFiles: string[]): Promise<boolean> {
        const unchangedFiles = await this._moduleFacade.UpdateVersion(DOWNLOAD_LOCATION(this._minerId), prevTag, currTag, prevUnchangedFiles)
        const  [hashes, authorData] = await this.parseAndBlame()
        const success = await DatabaseRequest.UploadHashes(hashes, metadata, authorData, prevVersionTime, unchangedFiles)
        prevUnchangedFiles = unchangedFiles
        return success
    }

    private trimHashes(hashes: HashData[], lines: Map<string, number[]>) {
        const result: HashData[] = []
        hashes.forEach(hash => {
            (lines.get(hash.FileName) || []).forEach(line => {
                if (hash.LineNumber <= line && line <= hash.LineNumberEnd) {
                    result.push(hash)
                    return
                }
            })
        })
        return result
    }

}

export class StartCommand extends Command {
    protected static _helpMessageText = "Start the miner"
    constructor(minerId: string, flags: Flags) {
        super(minerId, flags)
    }

    public async Execute(verbosity: Verbosity): Promise<void> {
        DatabaseRequest.SetVerbosity(verbosity)
        DatabaseRequest.SetMinerId(this._minerId)
        DatabaseRequest.ConnectToCassandraNode()

        while (!SigInt.Stop) {
            
            this._moduleFacade.ResetState()

            this._flags.Branch = ""
            const job = await DatabaseRequest.GetNextJob()
            const splitted = job.split('?')
            switch (splitted[0]) {
                case "Spider": {
                    Logger.Info(`New Job: Download and parse ${splitted[2]}`, Logger.GetCallerLocation())
                    const startTime = Date.now()
                    await this.processVersion(splitted, startTime)
                    break;
                }
                case "Crawl":
                    Logger.Info("New Job: Crawl for more URLs", Logger.GetCallerLocation())
                    await this.handleCrawlRequest(splitted)
                    break;
                
                case "NoJob":
                    Logger.Info("Waiting for a new job", Logger.GetCallerLocation())
                    await new Promise(resolve => setTimeout(resolve, 5000))
                    break;

                default: 
                    Logger.Warning("Unknown job type", Logger.GetCallerLocation())
                    break;
            }
        }

        SigInt.IsStopped = true
    }

    public HandleTimeout() {
        /* empty */
    }

    private async handleCrawlRequest(splitted: string[]) {
        const crawled = await this._moduleFacade.CrawlRepositories()
        await DatabaseRequest.AddCrawledJobs(crawled, splitted[2])
    }

    private async processVersion(splitted: string[], startTime: number) {
        if (splitted.length < 5 || !splitted[2]) {
            Logger.Warning("Unexpected job data received from database", Logger.GetCallerLocation())
            return
        }
        this._flags.MandatoryArgument = splitted[2]
        await this.uploadProject(splitted[1], splitted[3], startTime)
    }
}

export class ClaimCommand extends Command {
    protected static _helpMessageText: string

    public Execute(verbosity: Verbosity): Promise<void> {
        return Promise.resolve()
    }

}
