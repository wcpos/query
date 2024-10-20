import forEach from 'lodash/forEach';
import { Observable, Subject, Subscription } from 'rxjs';
import { filter, map } from 'rxjs/operators';

import { CollectionReplicationState } from './collection-replication-state';
import allHooks from './hooks';
import { QueryReplicationState } from './query-replication-state';
import { Query } from './query-state';
import { Registry } from './registry';
import { RelationalQuery } from './relational-query-state';
import { SubscribableBase } from './subscribable-base';
import { buildEndpointWithParams } from './utils';

import type { QueryParams } from './query-state';
import type { RxDatabase, RxCollection } from 'rxdb';

/**
 *
 */
export interface RegisterQueryConfig {
	queryKeys: (string | number | object)[];
	collectionName: string;
	initialParams?: QueryParams;
	endpoint?: string;
	greedy?: boolean;
}

/**
 *
 */
export class Manager<TDatabase extends RxDatabase> extends SubscribableBase {
	public readonly queryStates: Registry<string, Query<RxCollection>>;
	public readonly replicationStates: Registry<
		string,
		CollectionReplicationState<RxCollection> | QueryReplicationState<RxCollection>
	>;

	/**
	 * Each queryKey should have one collection replication and one query replication
	 */
	public readonly activeCollectionReplications: Registry<
		string,
		CollectionReplicationState<RxCollection>
	>;
	public readonly activeQueryReplications: Registry<string, QueryReplicationState<RxCollection>>;

	/**
	 *
	 */
	public readonly subjects = {
		error: new Subject<Error>(),
	};
	readonly error$: Observable<Error> = this.subjects.error.asObservable();

	/**
	 * Enforce singleton pattern
	 */
	// private static instanceCount = 0;
	// private instanceId: number;
	private static instance: Manager<any>;

	private constructor(
		public localDB: TDatabase,
		public fastLocalDB,
		public httpClient,
		public locale: string
	) {
		super();
		// Manager.instanceCount++;
		// this.instanceId = Manager.instanceCount;
		// console.log(`Manager instance created with ID: ${this.instanceId}`, {
		// 	localDB,
		// 	httpClient,
		// 	locale,
		// });

		this.queryStates = new Registry();
		this.replicationStates = new Registry();
		this.activeCollectionReplications = new Registry();
		this.activeQueryReplications = new Registry();

		// this.subs
		// 	.push
		// 	/**
		// 	 * Subscribe to localDB to detect if collection is reset
		// 	 */
		// 	// this.localDB.reset$.subscribe(this.onCollectionReset.bind(this))
		// 	();

		/**
		 * Subscribe to localDB to detect if db is destroyed
		 */
		this.localDB.onDestroy.push(() => this.cancel());
	}

	public static getInstance<TDatabase extends RxDatabase>(
		localDB: TDatabase,
		fastLocalDB,
		httpClient,
		locale: string = 'en'
	) {
		// Check if instance exists and dependencies are the same
		if (
			Manager.instance &&
			Manager.instance.localDB === localDB &&
			Manager.instance.fastLocalDB === fastLocalDB &&
			// Manager.instance.httpClient === httpClient && // @TODO - look into this
			Manager.instance.locale === locale
		) {
			return Manager.instance as Manager<TDatabase>;
		}

		// If instance exists but dependencies have changed, cancel the existing instance
		if (Manager.instance) {
			Manager.instance.cancel();
		}

		// Create a new instance
		Manager.instance = new Manager(localDB, fastLocalDB, httpClient, locale);
		return Manager.instance as Manager<TDatabase>;
	}

	stringify(params: any): string | undefined {
		try {
			return JSON.stringify(params);
		} catch (error) {
			this.subjects.error.next(new Error(`Failed to serialize query key: ${error}`));
		}
	}

	hasQuery(queryKeys: (string | number | object)[]): boolean {
		const key = this.stringify(queryKeys);
		return this.queryStates.has(key);
	}

	registerQuery({
		queryKeys,
		collectionName,
		initialParams,
		greedy,
		...args
	}: RegisterQueryConfig) {
		const key = this.stringify(queryKeys);
		const endpoint = args.endpoint || collectionName;
		const hooks = allHooks[collectionName] || {};

		if (!this.queryStates.has(key)) {
			const collection = this.getCollection(collectionName);
			if (collection) {
				const queryState = new Query<typeof collection>({
					id: key,
					collection,
					initialParams,
					hooks,
					endpoint,
					errorSubject: this.subjects.error,
					greedy,
					locale: this.locale,
				});

				this.queryStates.set(key, queryState);
				this.onNewQueryState(queryState);
			}
		}

		return this.queryStates.get(key);
	}

	registerRelationalQuery(
		{ queryKeys, collectionName, initialParams, greedy, ...args }: RegisterQueryConfig,
		childQuery: Query<any>,
		parentLookupQuery: Query<any>
	) {
		const key = this.stringify(queryKeys);
		const endpoint = args.endpoint || collectionName;
		const hooks = allHooks[collectionName] || {};

		if (!this.queryStates.has(key)) {
			const collection = this.getCollection(collectionName);
			if (collection) {
				const queryState = new RelationalQuery<typeof collection>(
					{
						id: key,
						collection,
						initialParams,
						hooks,
						endpoint,
						errorSubject: this.subjects.error,
						greedy,
						locale: this.locale,
					},
					childQuery,
					parentLookupQuery
				);

				this.queryStates.set(key, queryState);
				this.onNewQueryState(queryState);
			}
		}

		return this.queryStates.get(key);
	}

	getCollection(collectionName: string) {
		if (!this.localDB[collectionName]) {
			this.subjects.error.next(new Error(`Collection with name: ${collectionName} not found.`));
		}
		return this.localDB[collectionName];
	}

	getSyncCollection(collectionName: string) {
		if (!this.fastLocalDB[collectionName]) {
			this.subjects.error.next(
				new Error(`Sync collection with name: ${collectionName} not found.`)
			);
		}
		return this.fastLocalDB[collectionName];
	}

	getQuery(queryKeys: (string | number | object)[]) {
		const key = this.stringify(queryKeys);
		const query = this.queryStates.get(key);

		if (!query) {
			this.subjects.error.next(new Error(`Query with key: ${key} not found.`));
		}

		return query;
	}

	deregisterQuery(key: string): void {
		const query = this.queryStates.get(key);
		if (query) {
			this.queryStates.delete(key);
			this.activeCollectionReplications.delete(key);
			this.activeQueryReplications.delete(key);

			// cancel last, this will trigger the useQuery components to re-init the query
			query.cancel();
		}
	}

	/**
	 *
	 */
	onCollectionReset(collection) {
		// cancel all replication states for the collection
		this.replicationStates.forEach((replication, endpoint) => {
			if (replication.collection.name === collection.name) {
				this.deregisterReplication(endpoint);
			}
		});

		// cancel all query states for the collection
		this.queryStates.forEach((query, key) => {
			if (query.collection.name === collection.name) {
				this.deregisterQuery(key);
			}
		});
	}

	/**
	 * Tasks to perform when a new query state is registered
	 * - register a new collection replication state
	 * - start the collection replication
	 * - subscribe to the query params and register a new query replication state
	 */
	onNewQueryState(queryState: Query<RxCollection>) {
		const { collection, endpoint } = queryState;
		const collectionReplication = this.registerCollectionReplication({ collection, endpoint });
		this.activeCollectionReplications.set(queryState.id, collectionReplication);
		collectionReplication.start();

		/**
		 * Add internal subscriptions to the query state
		 * @TODO - should this be part of the events system?
		 */
		queryState.subs.push(
			/**
			 * Subscribe to query params and register a new replication state for the query
			 */
			queryState.params$.subscribe((params) => {
				let apiQueryParams = this.getApiQueryParams(params);
				const hooks = allHooks[queryState.collection.name] || {};
				if (hooks?.filterApiQueryParams) {
					apiQueryParams = hooks.filterApiQueryParams(apiQueryParams, params);
				}
				const queryEndpoint = buildEndpointWithParams(endpoint, apiQueryParams);
				const queryReplication = this.registerQueryReplication({
					collectionReplication,
					collection,
					queryEndpoint,
					greedy: queryState.greedy,
				});
				// if we're replacing an existing query replication, maybe pause it
				if (this.activeQueryReplications.has(queryState.id)) {
					this.maybePauseQueryReplications(queryState);
				}
				this.activeQueryReplications.set(queryState.id, queryReplication);

				queryReplication.start();
			})
		);
	}

	/**
	 * There is one replication state per collection
	 */
	registerCollectionReplication({ collection, endpoint }) {
		const replicationState = this.replicationStates.get(endpoint);
		const syncCollection = this.getSyncCollection(collection.name);
		if (!replicationState || !(replicationState instanceof CollectionReplicationState)) {
			const collectionReplication = new CollectionReplicationState({
				httpClient: this.httpClient,
				collection,
				syncCollection,
				endpoint,
				errorSubject: this.subjects.error,
			});

			collection.onRemove.push(() => this.onCollectionReset(collection));

			this.replicationStates.set(endpoint, collectionReplication);
		}

		return this.replicationStates.get(endpoint);
	}

	/**
	 * There is one replication state per query endpoint
	 */
	registerQueryReplication({ queryEndpoint, collectionReplication, collection, greedy }) {
		const replicationState = this.replicationStates.get(queryEndpoint);
		if (!replicationState || !(replicationState instanceof QueryReplicationState)) {
			const queryReplication = new QueryReplicationState({
				httpClient: this.httpClient,
				collectionReplication,
				collection,
				endpoint: queryEndpoint,
				errorSubject: this.subjects.error,
				greedy,
			});

			this.replicationStates.set(queryEndpoint, queryReplication);
		}

		return this.replicationStates.get(queryEndpoint);
	}

	/**
	 *
	 */
	deregisterReplication(endpoint: string) {
		const replicationState = this.replicationStates.get(endpoint);
		if (replicationState) {
			replicationState.cancel();
			this.replicationStates.delete(endpoint);
		}
	}

	/**
	 * Get the query params that are used for the API
	 * - NOTE: the api query params have a different format than the query params
	 * - allow hooks to modify the query params
	 */
	getApiQueryParams(queryParams: QueryParams = {}) {
		const params = {
			orderby: queryParams?.sortBy,
			order: queryParams?.sortDirection,
			per_page: 10,
		};

		if (queryParams?.search && typeof queryParams?.search === 'string') {
			params.search = queryParams?.search;
		}

		if (queryParams?.selector) {
			forEach(queryParams.selector, (value, key) => {
				if (key !== 'uuid') {
					params[key] = value;
				}
			});
		}

		return params;
	}

	/**
	 * When a useQuery is unmounted, we check if we need to pause the query replications
	 * - if there are no more useQuery components for a query, we pause the query replications
	 * - when a new useQuery component is mounted, we resume the query replications
	 * - collection replications are not paused
	 */
	maybePauseQueryReplications(query: Query<RxCollection>) {
		const activeQueryReplication = this.activeQueryReplications.get(query.id);
		const activeQueryReplications = this.getActiveQueryReplicationStatesByEndpoint(
			activeQueryReplication.endpoint
		);
		if (activeQueryReplications.length === 1) {
			activeQueryReplication.pause();
		}
	}

	getActiveQueryReplicationStatesByEndpoint(endpoint: string) {
		const matchingStates = [];
		this.activeQueryReplications.forEach((state) => {
			if (state.endpoint === endpoint) {
				matchingStates.push(state);
			}
		});
		return matchingStates;
	}

	/**
	 * Cancel
	 *
	 * Make sure we clean up subscriptions:
	 * - things we subscribe to in this class, also
	 * - complete the observables accessible from this class
	 * - cancel all queries
	 */
	cancel() {
		super.cancel();

		// Cancel all queries
		this.queryStates.forEach((query) => query.cancel());

		// Cancel all replications
		this.replicationStates.forEach((replication) => replication.cancel());
	}
}
