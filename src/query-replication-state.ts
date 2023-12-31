import isEmpty from 'lodash/isEmpty';
import { BehaviorSubject, Observable, Subscription, Subject, interval } from 'rxjs';
import {
	filter,
	tap,
	map,
	switchMap,
	startWith,
	debounceTime,
	distinctUntilChanged,
} from 'rxjs/operators';

import { SubscribableBase } from './subscribable-base';

import type { CollectionReplicationState } from './collection-replication-state';
import type { RxCollection } from 'rxdb';

interface QueryReplicationConfig<T extends RxCollection> {
	collection: T;
	httpClient: any;
	collectionReplication: CollectionReplicationState<T>;
	hooks?: any;
	endpoint: string;
	errorSubject: Subject<Error>;
}

export class QueryReplicationState<T extends RxCollection> extends SubscribableBase {
	private pollingTime = 1000 * 60 * 5; // 5 minutes
	public readonly collection: T;
	public readonly httpClient: any;
	public readonly endpoint: any;
	private errorSubject: Subject<Error>;
	public readonly collectionReplication: CollectionReplicationState<T>;
	public syncCompleted = false;

	/**
	 *
	 */
	public readonly subs: Subscription[] = [];
	public readonly subjects = {
		paused: new BehaviorSubject<boolean>(true), // true when the replication is paused, start true
		active: new BehaviorSubject<boolean>(false), // true when something is running, false when not
	};

	/**
	 *
	 */
	readonly paused$: Observable<boolean> = this.subjects.paused.asObservable();
	readonly active$: Observable<boolean> = this.subjects.active.asObservable();

	/**
	 *
	 */
	constructor({
		collection,
		httpClient,
		collectionReplication,
		endpoint,
		errorSubject,
	}: QueryReplicationConfig<T>) {
		super();
		this.collection = collection;
		this.httpClient = httpClient;
		this.endpoint = endpoint;
		this.collectionReplication = collectionReplication;
		this.errorSubject = errorSubject;

		/**
		 *
		 */
		this.subs.push(
			/**
			 * Pause/Start the replication
			 */
			this.paused$
				.pipe(
					switchMap((isPaused) => (isPaused ? [] : interval(this.pollingTime).pipe(startWith(0)))),
					filter(() => !this.subjects.paused.getValue())
				)
				.subscribe(async () => {
					this.run();
				})
		);
	}

	/**
	 *
	 */
	async run({ force }: { force?: boolean } = {}) {
		await this.collectionReplication.firstSync;
		await this.fetchUnsynced();
	}

	/**
	 *
	 */
	async fetchUnsynced() {
		if (this.isStopped() || this.subjects.active.getValue()) {
			return;
		}

		this.subjects.active.next(true);

		const include = await this.collectionReplication.getUnsyncedRemoteIDs();
		const exclude = await this.collectionReplication.getSyncedRemoteIDs();
		const lastModified = this.collectionReplication.subjects.lastModified.getValue();

		/**
		 * If query sync is already completed, we go to the collection sync
		 */
		if (this.syncCompleted) {
			this.subjects.active.next(false);
			return this.collectionReplication.fetchUnsynced();
		}

		try {
			let response;

			if (isEmpty(include)) {
				response = await this.fetchLastModified({ lastModified });
			} else {
				if (exclude?.length < include?.length) {
					response = await this.fetchUnsyncedRemoteIDs({ exclude });
				} else {
					response = await this.fetchUnsyncedRemoteIDs({ include });
				}
			}

			if (!Array.isArray(response?.data)) {
				throw new Error('Invalid response data for query replication');
			}

			if (response.data.length === 0) {
				this.syncCompleted = true;
			}

			const promises = response.data.map(async (doc) => {
				const parsedData = this.collection.parseRestResponse(doc);
				await this.collection.upsertRefs(parsedData); // upsertRefs mutates the parsedData
				return parsedData;
			});

			const documents = await Promise.all(promises);

			await this.collection.bulkUpsert(documents);
		} catch (error) {
			this.errorSubject.next(error);
		} finally {
			this.subjects.active.next(false);
		}
	}

	/**
	 *
	 */
	async fetchUnsyncedRemoteIDs({ include = undefined, exclude = undefined }) {
		const response = await this.httpClient.post(
			this.endpoint,
			{
				include,
				exclude,
			},
			{
				headers: {
					'X-HTTP-Method-Override': 'GET',
				},
			}
		);

		return response;
	}

	/**
	 *
	 */
	async fetchLastModified({ lastModified }) {
		const response = await this.httpClient.get(this.endpoint, {
			params: {
				modified_after: lastModified,
			},
		});

		return response;
	}

	/**
	 *
	 */
	nextPage() {
		this.run();
	}

	/**
	 * We need to a way to pause and start the replication, eg: when the user is offline
	 */
	start() {
		this.subjects.paused.next(false);
	}

	pause() {
		this.subjects.paused.next(true);
	}

	isStopped() {
		return this.isCanceled || this.subjects.paused.getValue();
	}
}
